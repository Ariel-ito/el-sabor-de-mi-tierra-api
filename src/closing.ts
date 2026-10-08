import { assertQuantity, qtyText } from "./units";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { allocateStock, inventory } from "./inventory";
import { decimal } from "./math";
export type CloseDecision = {
  receiptItemId: string;
  reason: "LOSS" | "SAMPLE" | "PERSONAL" | "KEEP";
  quantity: string;
};
// What stands between a cycle and closing: its encargos must be fully
// delivered, and every free pound it bought needs a destination.
export async function closingState(
  tx: Prisma.TransactionClient,
  roundId: string,
) {
  await allocateStock(tx);
  const orders = await tx.order.findMany({
    where: { roundId, kind: "ENCARGO" },
    include: {
      customer: true,
      items: { include: { product: true, allocations: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const pendingOf = (i: {
    quantity: Prisma.Decimal;
    allocations: { delivered: Prisma.Decimal }[];
  }) =>
    i.quantity.sub(
      i.allocations.reduce((s, a) => s.add(a.delivered), decimal(0)),
    );
  // Lines carried to another cycle are delivered there and do not hold this
  // one open; lines carried here from earlier cycles do.
  const carriedIn = await tx.orderItem.findMany({
    where: { fulfillRoundId: roundId, order: { roundId: { not: roundId } } },
    include: {
      product: true,
      allocations: true,
      order: { include: { customer: true, round: true } },
    },
  });
  const pendingDeliveries = [
    ...orders.flatMap((o) => {
      const items = o.items.flatMap((i) => {
        const pending = pendingOf(i);
        return pending.gt(0) &&
          !(i.fulfillRoundId && i.fulfillRoundId !== roundId)
          ? [
              {
                name: i.product.name,
                unit: i.product.unit,
                pending: pending.toString(),
              },
            ]
          : [];
      });
      return items.length
        ? [
            {
              orderId: o.id,
              customerName: o.customer.name,
              fromRound: null,
              items,
            },
          ]
        : [];
    }),
    ...carriedIn.flatMap((i) => {
      const pending = pendingOf(i);
      return pending.gt(0)
        ? [
            {
              orderId: i.orderId,
              customerName: i.order.customer.name,
              fromRound: i.order.round.name,
              items: [
                {
                  name: i.product.name,
                  unit: i.product.unit,
                  pending: pending.toString(),
                },
              ],
            },
          ]
        : [];
    }),
  ];
  const carried = await tx.orderItem.findMany({
    where: {
      order: { roundId },
      fulfillRoundId: { not: null },
      NOT: { fulfillRoundId: roundId },
    },
    include: {
      product: true,
      allocations: true,
      order: { include: { customer: true } },
      fulfillRound: true,
    },
  });
  const carriedOut = carried
    .filter((i) => pendingOf(i).gt(0))
    .map((i) => ({
      orderId: i.orderId,
      customerName: i.order.customer.name,
      name: i.product.name,
      unit: i.product.unit,
      pending: pendingOf(i).toString(),
      toRound: i.fulfillRound!.name,
    }));
  const leftovers = (await inventory(tx))
    .filter((l) => l.roundId === roundId && decimal(l.available).gt(0))
    .map((l) => ({
      receiptItemId: l.id,
      productName: l.productName,
      unit: l.unit,
      supplierName: l.supplierName,
      receivedAt: l.receivedAt,
      invoice: l.invoice,
      available: l.available,
      unitCost: l.unitCost,
    }));
  return { pendingDeliveries, leftovers, carriedOut };
}
export async function applyClosing(
  tx: Prisma.TransactionClient,
  roundId: string,
  roundName: string,
  decisions: CloseDecision[],
) {
  const { pendingDeliveries, leftovers } = await closingState(tx, roundId);
  if (pendingDeliveries.length)
    throw new ConflictException(
      `Hay ${pendingDeliveries.length === 1 ? "1 encargo" : `${pendingDeliveries.length} encargos`} con producto sin entregar. Entrégalos antes de cerrar el ciclo.`,
    );
  for (const d of decisions) {
    const lot = leftovers.find((l) => l.receiptItemId === d.receiptItemId);
    if (lot) assertQuantity(lot.unit, d.quantity, lot.productName);
  }
  for (const d of decisions)
    if (!leftovers.some((l) => l.receiptItemId === d.receiptItemId))
      throw new BadRequestException(
        "Hay una decisión para un lote que no es sobrante de este ciclo.",
      );
  for (const lot of leftovers) {
    const decided = decisions
      .filter((d) => d.receiptItemId === lot.receiptItemId)
      .reduce((s, d) => s.add(d.quantity), decimal(0));
    if (!decided.eq(lot.available))
      throw new BadRequestException(
        `${lot.productName}: quedan ${qtyText(lot.available, lot.unit)} libres y decidiste ${qtyText(decided, lot.unit)}. Reparte todo el sobrante.`,
      );
  }
  const withdrawals = decisions.filter(
    (d) => d.reason !== "KEEP" && decimal(d.quantity).gt(0),
  );
  for (const d of withdrawals)
    await tx.stockWithdrawal.create({
      data: {
        id: randomUUID(),
        receiptItemId: d.receiptItemId,
        quantity: d.quantity,
        reason: d.reason,
        notes: `Cierre de ciclo ${roundName}`,
      },
    });
  return { leftovers, withdrawals };
}
