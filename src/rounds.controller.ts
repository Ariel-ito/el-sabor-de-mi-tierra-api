import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db, lockRound } from "./core";
import { cycleCosts, Lot } from "./costing";
import { RoundDto, RoundPatchDto } from "./dto";
import { allocateStock, stockLock } from "./inventory";
import { decimal, orderInclude, purchaseSummary, statistics } from "./math";
import { purchaseInclude } from "./purchases";
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class RoundsController {
  constructor(@Inject(Db) private db: Db) {}
  @Get("rounds") rounds() {
    return this.db.round.findMany({ orderBy: { createdAt: "desc" } });
  }
  @Post("rounds") createRound(@Body() body: RoundDto) {
    if (new Date(body.closesAt) <= new Date(body.opensAt))
      throw new BadRequestException(
        "El cierre debe ser posterior a la apertura",
      );
    return this.db.round.create({ data: body });
  }
  @Patch("rounds/:id") patchRound(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RoundPatchDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await lockRound(tx, id);
      if (
        new Date(body.closesAt ?? before.closesAt) <=
        new Date(body.opensAt ?? before.opensAt)
      )
        throw new BadRequestException(
          "El cierre debe ser posterior a la apertura",
        );
      const after = await tx.round.update({ where: { id }, data: body });
      await audit(tx, req.actor.id, "Round", id, "UPDATE", before, after);
      return after;
    });
  }
  @Get("statistics") async stats() {
    const [rounds, orders, receipts] = await this.db.$transaction([
      this.db.round.findMany({ orderBy: { opensAt: "desc" } }),
      this.db.order.findMany({
        include: {
          ...orderInclude,
          items: {
            include: {
              product: true,
              supplier: true,
              allocations: { include: { receiptItem: true } },
            },
          },
        },
      }),
      this.db.receiptItem.findMany({
        include: { purchaseItem: { include: { purchase: true } } },
      }),
    ]);
    const lots: Lot[] = receipts.map((r) => ({
      productId: r.purchaseItem.productId,
      supplierId: r.purchaseItem.purchase.supplierId,
      roundId: r.purchaseItem.purchase.roundId,
      quantity: r.quantity,
      unitCost: r.effectiveUnitCost,
    }));
    const result = statistics(rounds, orders);
    return {
      ...result,
      cycles: result.cycles.map((c) => ({
        ...c,
        ...cycleCosts(
          c.id,
          orders.filter((o) => o.roundId === c.id),
          lots,
        ),
      })),
    };
  }
  @Get("rounds/:id/purchase-summary") async summary(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        await allocateStock(tx);
        await tx.round.findUniqueOrThrow({ where: { id } });
        const orders = await tx.order.findMany({
          where: { roundId: id },
          include: orderInclude,
        });
        const result = purchaseSummary(id, orders);
        const purchases = await tx.purchase.findMany({
          where: { roundId: id },
          include: purchaseInclude,
        });
        for (const group of result.groups)
          for (const row of group.items) {
            const missing = orders
              .flatMap((o) => o.items)
              .filter(
                (i) =>
                  i.source !== "STOCK" &&
                  i.productId === row.productId &&
                  i.supplierId === group.supplierId,
              )
              .reduce(
                (s, i) =>
                  s
                    .add(i.quantity)
                    .sub(
                      i.allocations.reduce(
                        (a, b) => a.add(b.quantity),
                        decimal(0),
                      ),
                    ),
                decimal(0),
              );
            const incoming = purchases
              .filter((p) => p.supplierId === group.supplierId)
              .reduce(
                (sum, p) =>
                  sum.add(
                    p.items
                      .filter((i) => i.productId === row.productId)
                      .reduce(
                        (s, i) =>
                          s.add(i.quantity).sub(
                            p.receipts
                              .flatMap((r) => r.items)
                              .filter((r) => r.purchaseItemId === i.id)
                              .reduce((a, r) => a.add(r.quantity), decimal(0)),
                          ),
                        decimal(0),
                      ),
                  ),
                decimal(0),
              );
            (row as any).pendingToBuy = Prisma.Decimal.max(
              0,
              missing.sub(incoming),
            ).toString();
          }
        return result;
      },
      { timeout: 15000 },
    );
  }
}
