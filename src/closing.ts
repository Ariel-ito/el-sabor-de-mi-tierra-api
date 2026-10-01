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
  const pendingDeliveries = orders.flatMap((o) => {
    const items = o.items.flatMap((i) => {
      const delivered = i.allocations.reduce(
        (s, a) => s.add(a.delivered),
        decimal(0),
      );
      const pending = i.quantity.sub(delivered);
      return pending.gt(0)
        ? [{ name: i.product.name, pending: pending.toString() }]
        : [];
    });
    return items.length
      ? [{ orderId: o.id, customerName: o.customer.name, items }]
      : [];
  });
  const leftovers = (await inventory(tx))
    .filter((l) => l.roundId === roundId && decimal(l.available).gt(0))
    .map((l) => ({
      receiptItemId: l.id,
      productName: l.productName,
      supplierName: l.supplierName,
      receivedAt: l.receivedAt,
      invoice: l.invoice,
      available: l.available,
      unitCost: l.unitCost,
    }));
  return { pendingDeliveries, leftovers };
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
      `Hay ${pendingDeliveries.length === 1 ? "1 encargo" : `${pendingDeliveries.length} encargos`} con libras sin entregar. Entrégalos antes de cerrar el ciclo.`,
    );
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
        `${lot.productName}: quedan ${lot.available} lb libres y decidiste ${decided} lb. Reparte todo el sobrante.`,
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
