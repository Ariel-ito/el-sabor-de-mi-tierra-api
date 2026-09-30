import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db, lockRound } from "./core";
import { PurchaseDto, ReceiptDto } from "./dto";
import { allocateStock, stockLock } from "./inventory";
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
      where: roundId ? { roundId } : {},
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
