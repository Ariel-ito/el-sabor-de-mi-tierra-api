import { checkQuantities, qtyText } from "./units";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db, lockRound } from "./core";
import { PurchaseDto, PurchasePatchDto, ReceiptDto } from "./dto";
import { allocateStock, stockLock } from "./inventory";
import { decimal } from "./math";
import { purchaseInclude, receive } from "./purchases";
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class PurchasesController {
  constructor(@Inject(Db) private db: Db) {}
  @Get("purchases") purchases(
    @Query("roundId", new ParseUUIDPipe({ optional: true })) roundId?: string,
  ) {
    return this.db.purchase.findMany({
      // Combos assembled from stock are not supplier purchases.
      where: { kind: "PURCHASE", ...(roundId ? { roundId } : {}) },
      include: purchaseInclude,
      orderBy: { orderedAt: "desc" },
    });
  }
  @Post("purchases") createPurchase(
    @Body() body: PurchaseDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockRound(tx, body.roundId);
      if (body.id) {
        const existing = await tx.purchase.findUnique({
          where: { id: body.id },
          include: purchaseInclude,
        });
        if (existing) {
          if (
            existing.roundId !== body.roundId ||
            existing.supplierId !== body.supplierId
          )
            throw new ConflictException("Identificador de compra ya utilizado");
          return existing;
        }
      }
      if (new Date(body.orderedAt) > new Date())
        throw new BadRequestException(
          "La fecha del pedido no puede ser futura",
        );
      if (
        new Set(body.items.map((i) => i.productId)).size !== body.items.length
      )
        throw new BadRequestException("Producto repetido");
      await checkQuantities(tx, body.items);
      const after = await tx.purchase.create({
        data: {
          id: body.id,
          roundId: body.roundId,
          supplierId: body.supplierId,
          orderedAt: new Date(body.orderedAt),
          items: { create: body.items },
        },
        include: purchaseInclude,
      });
      await audit(
        tx,
        req.actor.id,
        "Purchase",
        after.id,
        "CREATE",
        null,
        after,
      );
      return after;
    });
  }
  // Editable only while its cycle is open and before any invoice is recorded;
  // after that the purchase is history and changes go in an additional one.
  @Patch("purchases/:id") patchPurchase(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: PurchasePatchDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const current = await tx.purchase.findUnique({ where: { id } });
      if (!current || current.kind !== "PURCHASE")
        throw new NotFoundException("Compra no encontrada");
      const round = await lockRound(tx, current.roundId);
      if (round.status !== "OPEN")
        throw new ConflictException(
          "El ciclo está cerrado. Reábrelo para editar la compra.",
        );
      await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id=${id}::uuid FOR UPDATE`;
      const before = await tx.purchase.findUniqueOrThrow({
        where: { id },
        include: purchaseInclude,
      });
      if (before.receipts.length)
        throw new ConflictException(
          "Esta compra ya tiene factura registrada y no se edita. Registra una compra adicional para los cambios.",
        );
      if (before.version !== body.version)
        throw new ConflictException(
          "La compra cambió; actualiza antes de editarla.",
        );
      if (
        new Set(body.items.map((i) => i.productId)).size !== body.items.length
      )
        throw new BadRequestException("Producto repetido");
      await checkQuantities(tx, body.items);
      const received = (itemId: string) =>
        before.receipts
          .flatMap((r) => r.items)
          .filter((r) => r.purchaseItemId === itemId)
          .reduce((s, r) => s.add(r.quantity), decimal(0));
      for (const old of before.items) {
        const next = body.items.find((i) => i.productId === old.productId);
        const got = received(old.id);
        if (got.gt(next?.quantity ?? 0))
          throw new BadRequestException(
            next
              ? `${old.product.name}: ya se recibieron ${qtyText(got, old.product.unit)}; no puedes pedir menos.`
              : `${old.product.name}: ya se recibieron ${qtyText(got, old.product.unit)}; no puedes quitarlo.`,
          );
        if (!next) await tx.purchaseItem.delete({ where: { id: old.id } });
        else
          await tx.purchaseItem.update({
            where: { id: old.id },
            data: {
              quantity: next.quantity,
              quotedUnitCost: next.quotedUnitCost,
            },
          });
      }
      const added = body.items.filter(
        (i) => !before.items.some((o) => o.productId === i.productId),
      );
      if (added.length)
        await tx.purchaseItem.createMany({
          data: added.map((i) => ({ ...i, purchaseId: id })),
        });
      await tx.purchase.update({
        where: { id },
        data: { version: { increment: 1 } },
      });
      const after = await tx.purchase.findUniqueOrThrow({
        where: { id },
        include: purchaseInclude,
      });
      await audit(tx, req.actor.id, "Purchase", id, "UPDATE", before, after);
      return after;
    });
  }
  // A purchase nothing has arrived for can be removed, e.g. to redo it as
  // one order.
  @Delete("purchases/:id") deletePurchase(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("version", ParseIntPipe) version: number,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const current = await tx.purchase.findUnique({ where: { id } });
      if (!current || current.kind !== "PURCHASE")
        throw new NotFoundException("Compra no encontrada");
      await lockRound(tx, current.roundId);
      await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id=${id}::uuid FOR UPDATE`;
      const before = await tx.purchase.findUniqueOrThrow({
        where: { id },
        include: purchaseInclude,
      });
      if (before.version !== version)
        throw new ConflictException(
          "La compra cambió; actualiza antes de eliminarla.",
        );
      if (before.receipts.length)
        throw new ConflictException(
          "Esta compra ya tiene producto recibido; no se puede eliminar.",
        );
      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
      await tx.purchase.delete({ where: { id } });
      await audit(tx, req.actor.id, "Purchase", id, "DELETE", before, {
        deleted: true,
      });
      return { ok: true };
    });
  }
  @Post("purchases/:id/receipts") receipt(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ReceiptDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const result = await receive(tx, id, body, req.actor.id);
        await allocateStock(tx);
        return result;
      },
      { timeout: 15000 },
    );
  }
}
