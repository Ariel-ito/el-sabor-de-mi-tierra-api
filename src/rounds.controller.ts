import {
  BadRequestException,
  Body,
  ConflictException,
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
import { applyClosing, closingState } from "./closing";
import { CloseRoundDto, RoundDto, RoundPatchDto } from "./dto";
import { allocateStock, inventory, stockLock } from "./inventory";
import {
  decimal,
  money,
  orderInclude,
  purchaseSummary,
  statistics,
} from "./math";
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
      await stockLock(tx);
      const before = await lockRound(tx, id);
      if (
        new Date(body.closesAt ?? before.closesAt) <=
        new Date(body.opensAt ?? before.opensAt)
      )
        throw new BadRequestException(
          "El cierre debe ser posterior a la apertura",
        );
      if (body.status === "CLOSED" && before.status === "OPEN") {
        const state = await closingState(tx, id);
        if (state.pendingDeliveries.length || state.leftovers.length)
          throw new ConflictException(
            "El ciclo tiene entregas pendientes o sobrante sin decidir. Usa Cerrar ciclo.",
          );
      }
      const after = await tx.round.update({ where: { id }, data: body });
      await audit(tx, req.actor.id, "Round", id, "UPDATE", before, after);
      return after;
    });
  }
  @Get("rounds/:id/closing") closing(@Param("id", ParseUUIDPipe) id: string) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        await lockRound(tx, id);
        return closingState(tx, id);
      },
      { timeout: 15000 },
    );
  }
  @Post("rounds/:id/close") close(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CloseRoundDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const before = await lockRound(tx, id);
        if (before.status !== "OPEN")
          throw new ConflictException("El ciclo ya está cerrado.");
        const result = await applyClosing(tx, id, before.name, body.decisions);
        const after = await tx.round.update({
          where: { id },
          data: { status: "CLOSED" },
        });
        await audit(tx, req.actor.id, "Round", id, "CLOSE", before, {
          ...after,
          decisions: body.decisions,
          leftovers: result.leftovers,
        });
        return after;
      },
      { timeout: 15000 },
    );
  }
  @Get("statistics") async stats() {
    const [rounds, orders, receipts, expenses] = await this.db.$transaction([
      this.db.round.findMany({ orderBy: { opensAt: "desc" } }),
      this.db.order.findMany({
        include: {
          ...orderInclude,
          items: {
            include: {
              product: { include: { category: true } },
              supplier: true,
              allocations: { include: { receiptItem: true } },
            },
          },
        },
      }),
      this.db.receiptItem.findMany({
        include: {
          purchaseItem: { include: { purchase: true, product: true } },
          allocations: true,
          withdrawals: true,
        },
      }),
      this.db.financeMovement.findMany({
        where: {
          roundId: { not: null },
          kind: "EXPENSE",
          status: "PAID",
          category: { inResult: true },
        },
        include: { category: true },
      }),
    ]);
    const lots: Lot[] = receipts.map((r) => ({
      productId: r.purchaseItem.productId,
      supplierId: r.purchaseItem.purchase.supplierId,
      roundId: r.purchaseItem.purchase.roundId,
      quantity: r.quantity,
      unitCost: r.effectiveUnitCost,
      unit: r.purchaseItem.product.unit,
      withdrawals: r.withdrawals,
      free: r.quantity
        .sub(r.allocations.reduce((a, x) => a.add(x.quantity), decimal(0)))
        .sub(r.withdrawals.reduce((a, x) => a.add(x.quantity), decimal(0))),
    }));
    const result = statistics(rounds, orders);
    return {
      ...result,
      cycles: result.cycles.map((c) => {
        const costs = cycleCosts(
          c.id,
          orders.filter((o) => o.roundId === c.id),
          lots,
        );
        const own = expenses.filter((e) => e.roundId === c.id);
        const spent = own.reduce((a, e) => a.add(e.amount), decimal(0));
        const fuel = own
          .filter((e) => e.category.systemKey === "TRANSPORT")
          .reduce((a, e) => a.add(e.amount), decimal(0));
        // Sales, cost and profit per line of business.
        const byCategory = new Map<
          string,
          { sales: Prisma.Decimal; cost: Prisma.Decimal }
        >();
        for (const p of costs.productCosts) {
          const row = byCategory.get(p.category) ?? {
            sales: decimal(0),
            cost: decimal(0),
          };
          row.sales = row.sales.add(p.sales);
          row.cost = row.cost.add(p.cost);
          byCategory.set(p.category, row);
        }
        return {
          ...c,
          ...costs,
          categories: [...byCategory.entries()]
            .map(([name, r]) => ({
              name,
              sales: money(r.sales),
              cost: money(r.cost),
              profit: money(r.sales.sub(r.cost)),
            }))
            .sort((a, b) => Number(b.sales) - Number(a.sales)),
          // Product margin, plus shipping charged, minus the cycle's own
          // operating expenses from Contabilidad.
          productResult: costs.result,
          expenses: money(spent),
          fuel: money(fuel),
          result:
            costs.result === null
              ? null
              : money(decimal(costs.result).add(c.shipping).sub(spent)),
        };
      }),
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
        const lotRound = new Map(
          (await inventory(tx)).map((l) => [l.id, l.roundId]),
        );
        // A carried line counts in its own cycle only for what that cycle's
        // lots covered; the rest is bought in the cycle it was carried to.
        const orders = (
          await tx.order.findMany({
            where: {
              OR: [
                { roundId: id },
                { items: { some: { fulfillRoundId: id } } },
              ],
            },
            include: orderInclude,
          })
        ).map((o) => ({
          ...o,
          items: o.items.flatMap((i) => {
            if (!i.fulfillRoundId) return o.roundId === id ? [i] : [];
            const fromOwn = i.allocations
              .filter((a) => lotRound.get(a.receiptItemId) === o.roundId)
              .reduce((s, a) => s.add(a.quantity), decimal(0));
            const quantity =
              o.roundId === id ? fromOwn : i.quantity.sub(fromOwn);
            const allocations = i.allocations.filter(
              (a) => lotRound.get(a.receiptItemId) === id,
            );
            return quantity.gt(0) &&
              (o.roundId === id || i.fulfillRoundId === id)
              ? [{ ...i, quantity, allocations }]
              : [];
          }),
        }));
        // A combo nobody has assembled yet is bought as its components.
        const recipes = await tx.productComponent.findMany({
          include: { component: { include: { defaultSupplier: true } } },
        });
        for (const o of orders)
          o.items = o.items.flatMap((i: any) => {
            const parts = recipes.filter((r) => r.comboId === i.productId);
            if (!parts.length || i.source === "STOCK") return [i];
            const pending = decimal(i.quantity).sub(
              i.allocations.reduce(
                (a: Prisma.Decimal, x: any) => a.add(x.quantity),
                decimal(0),
              ),
            );
            if (pending.lte(0)) return [];
            return parts.map((r) => ({
              ...i,
              productId: r.componentId,
              product: r.component,
              supplierId: r.component.defaultSupplierId,
              supplier: r.component.defaultSupplier,
              quantity: pending.mul(r.quantity),
              allocations: [],
            }));
          });
        const result = purchaseSummary(id, orders);
        const purchases = await tx.purchase.findMany({
          where: { roundId: id, kind: "PURCHASE" },
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
