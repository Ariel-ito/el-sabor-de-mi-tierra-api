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
import {
  PurchaseDto,
  PurchasePatchDto,
  PurchaseSupplierDto,
  ReceiptDto,
} from "./dto";
import { allocateStock, stockLock } from "./inventory";
import { decimal, money } from "./math";
import { purchaseInclude, receive } from "./purchases";
import { directProductIds, resolvePurchaseSupplier } from "./purchase-supplier";
import { syncComboCosts } from "./assemblies.controller";
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class PurchasesController {
  constructor(@Inject(Db) private db: Db) {}
  @Get("purchases") async purchases(
    @Query("roundId", new ParseUUIDPipe({ optional: true })) roundId?: string,
  ) {
    const purchases = await this.db.purchase.findMany({
      // Combos assembled from stock are not supplier purchases.
      where: { kind: "PURCHASE", ...(roundId ? { roundId } : {}) },
      include: purchaseInclude,
      orderBy: { orderedAt: "desc" },
    });
    const commands = await this.db.auditLog.findMany({
      where: {
        entityType: "DirectPurchase",
        entityId: { in: purchases.map((p) => p.id) },
      },
      select: { entityId: true, after: true },
    });
    const created = new Map(
      commands.map((c) => [c.entityId, directProductIds(c.after)]),
    );
    return purchases.map((p) => ({
      ...p,
      createdProductIds: created.get(p.id) ?? [],
    }));
  }
  // Correct attribution without replacing receipts, lot IDs or their allocations.
  // A closed cycle also permits this metadata correction; values never change.
  @Patch("purchases/:id/supplier") correctSupplier(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: PurchaseSupplierDto,
    @Req() req: AuthRequest,
  ) {
    const fingerprint = JSON.stringify(body);
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const prior = await tx.auditLog.findUnique({ where: { id: body.id } });
        if (prior) {
          const result = prior.after as { request: string };
          if (
            prior.entityType !== "PurchaseSupplierCorrection" ||
            prior.entityId !== id ||
            prior.actorId !== req.actor.id ||
            result.request !== fingerprint
          )
            throw new ConflictException(
              "Este identificador ya corresponde a otra corrección.",
            );
          return tx.purchase.findUniqueOrThrow({
            where: { id },
            include: purchaseInclude,
          });
        }
        const current = await tx.purchase.findUnique({ where: { id } });
        if (!current || current.kind !== "PURCHASE")
          throw new NotFoundException("Compra no encontrada.");
        await lockRound(tx, current.roundId);
        await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id=${id}::uuid FOR UPDATE`;
        const before = await tx.purchase.findUniqueOrThrow({
          where: { id },
          include: purchaseInclude,
        });
        if (before.version !== body.version)
          throw new ConflictException(
            "La compra cambió; actualiza antes de corregir el proveedor.",
          );
        const supplier = await resolvePurchaseSupplier(tx, body, req.actor.id);
        if (supplier.id === before.supplierId)
          throw new BadRequestException("La compra ya tiene ese proveedor.");
        const command = await tx.auditLog.findUnique({ where: { id } });
        const created =
          command?.entityType === "DirectPurchase"
            ? directProductIds(command.after)
            : [];
        const correctedProducts: string[] = [];
        const productChanges = [];
        for (const productId of before.items.map((i) => i.productId).sort())
          await tx.$queryRaw`SELECT id FROM "Product" WHERE id=${productId}::uuid FOR UPDATE`;
        await tx.purchase.update({
          where: { id },
          data: { supplierId: supplier.id, version: { increment: 1 } },
        });
        for (const item of before.items) {
          const product = await tx.product.findUniqueOrThrow({
            where: { id: item.productId },
          });
          const moveDefault =
            body.correctCreatedProducts &&
            created.includes(product.id) &&
            product.defaultSupplierId === before.supplierId;
          if (moveDefault) {
            const duplicate = await tx.product.findFirst({
              where: {
                id: { not: product.id },
                defaultSupplierId: supplier.id,
                name: { equals: product.name, mode: "insensitive" },
              },
            });
            if (duplicate)
              throw new ConflictException(
                `${product.name} ya existe con ${supplier.name}. Revisa el catálogo antes de cambiarlo.`,
              );
            await tx.product.update({
              where: { id: product.id },
              data: { defaultSupplierId: supplier.id },
            });
            correctedProducts.push(product.id);
          }
          const defaultId = moveDefault
            ? supplier.id
            : product.defaultSupplierId;
          const dates = before.receipts
            .filter((r) => r.items.some((l) => l.purchaseItemId === item.id))
            .map((r) => r.receivedAt.getTime());
          const cursor = product.costEffectiveAt?.getTime();
          const syncCost =
            moveDefault ||
            dates.some((d) => d === cursor) ||
            (defaultId === supplier.id &&
              dates.some((d) => cursor == null || d >= cursor));
          if (syncCost) {
            const latest = await tx.receiptItem.findFirst({
              where: {
                purchaseItem: {
                  productId: product.id,
                  purchase: { kind: "PURCHASE", supplierId: defaultId },
                },
              },
              include: { receipt: true },
              orderBy: [
                { receipt: { receivedAt: "desc" } },
                { receipt: { createdAt: "desc" } },
                { id: "desc" },
              ],
            });
            // Without another invoice, keep the estimate but stop presenting it
            // as an actual price confirmed for the habitual supplier.
            await tx.product.update({
              where: { id: product.id },
              data: latest
                ? {
                    estimatedCost: money(latest.effectiveUnitCost),
                    costEffectiveAt: latest.receipt.receivedAt,
                  }
                : { costEffectiveAt: null },
            });
          }
          const afterProduct = await tx.product.findUniqueOrThrow({
            where: { id: product.id },
          });
          if (moveDefault || syncCost) {
            await audit(
              tx,
              req.actor.id,
              "Product",
              product.id,
              "CORRECT_PURCHASE_SUPPLIER",
              product,
              afterProduct,
            );
            productChanges.push({
              id: product.id,
              before: product,
              after: afterProduct,
            });
          }
        }
        const combos = await tx.productComponent.findMany({
          where: { componentId: { in: before.items.map((i) => i.productId) } },
        });
        await syncComboCosts(tx, [...new Set(combos.map((c) => c.comboId))]);
        const after = await tx.purchase.findUniqueOrThrow({
          where: { id },
          include: purchaseInclude,
        });
        await audit(
          tx,
          req.actor.id,
          "Purchase",
          id,
          "CORRECT_SUPPLIER",
          before,
          after,
        );
        await tx.auditLog.create({
          data: {
            id: body.id,
            actorId: req.actor.id,
            entityType: "PurchaseSupplierCorrection",
            entityId: id,
            action: "UPDATE",
            before: { supplierId: before.supplierId, version: before.version },
            after: JSON.parse(
              JSON.stringify({
                request: fingerprint,
                reason: body.reason.trim(),
                supplierId: supplier.id,
                correctedProducts,
                productChanges,
              }),
            ),
          },
        });
        return after;
      },
      { timeout: 30000 },
    );
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
