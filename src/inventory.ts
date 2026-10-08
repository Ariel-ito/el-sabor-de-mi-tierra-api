import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { decimal } from "./math";
// All inventory/order mutations acquire this lock before any row locks.
// Serializes the small private workspace and prevents overselling across cycles.
export async function stockLock(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7300929)`;
}
const lotInclude = {
  purchaseItem: {
    include: {
      product: true,
      purchase: { include: { supplier: true, round: true } },
    },
  },
  receipt: true,
  allocations: true,
  withdrawals: true,
} as const;
const hnDay = (d: Date) => Math.floor((d.getTime() - 6 * 3600000) / 86400000);
// Days left counted in Honduras calendar days; SOON inside the warning window.
export function expiry(
  expiresAt: Date | null,
  product: { shelfLifeDays: number | null; warnDays: number | null },
  now = new Date(),
) {
  if (!expiresAt)
    return { expiresAt: null, daysLeft: null, expiryStatus: null };
  const daysLeft = hnDay(expiresAt) - hnDay(now);
  const warn = product.warnDays ?? 1;
  return {
    expiresAt,
    daysLeft,
    expiryStatus: daysLeft < 0 ? "EXPIRED" : daysLeft <= warn ? "SOON" : "OK",
  };
}
export async function inventory(tx: Prisma.TransactionClient) {
  const lots = await tx.receiptItem.findMany({
    include: lotInclude,
    orderBy: [{ receipt: { receivedAt: "asc" } }, { id: "asc" }],
  });
  return lots.map((l) => {
    const assigned = l.allocations.reduce(
      (s, a) => s.add(a.quantity),
      decimal(0),
    );
    const delivered = l.allocations.reduce(
      (s, a) => s.add(a.delivered),
      decimal(0),
    );
    const withdrawn = l.withdrawals.reduce(
      (s, a) => s.add(a.quantity),
      decimal(0),
    );
    return {
      id: l.id,
      productId: l.purchaseItem.productId,
      productName: l.purchaseItem.product.name,
      unit: l.purchaseItem.product.unit,
      shelfLifeDays: l.purchaseItem.product.shelfLifeDays,
      supplierId: l.purchaseItem.purchase.supplierId,
      supplierName: l.purchaseItem.purchase.supplier.name,
      cycleName: l.purchaseItem.purchase.round.name,
      roundId: l.purchaseItem.purchase.roundId,
      receivedAt: l.receipt.receivedAt,
      invoice: l.receipt.invoice,
      quantity: l.quantity.toString(),
      available: l.quantity.sub(assigned).sub(withdrawn).toString(),
      reserved: assigned.sub(delivered).toString(),
      delivered: delivered.toString(),
      onHand: l.quantity.sub(delivered).sub(withdrawn).toString(),
      unitCost: l.effectiveUnitCost.toString(),
      withdrawals: l.withdrawals,
      ...expiry(l.expiresAt, l.purchaseItem.product),
    };
  });
}
// Fill unreserved quantities oldest encargo first. Existing assignments remain
// attached to their receipt, including delivered quantities, across cycle closes.
// Pass 1 matches the line's supplier for every line; pass 2 lets encargos
// still short take the same product from another supplier of their cycle, so
// buying elsewhere never strands an encargo nor steals a supplier's own lots.
export async function allocateStock(tx: Prisma.TransactionClient) {
  const lots = await inventory(tx);
  const items = await tx.orderItem.findMany({
    include: { allocations: true, order: true },
    orderBy: [{ order: { createdAt: "asc" } }, { id: "asc" }],
  });
  const need = new Map(
    items.map((item) => [
      item.id,
      item.quantity.sub(
        item.allocations.reduce((s, a) => s.add(a.quantity), decimal(0)),
      ),
    ]),
  );
  const fill = async (item: (typeof items)[number], anySupplier: boolean) => {
    let left = need.get(item.id)!;
    for (const lot of lots) {
      if (left.lte(0)) break;
      // Encargo lines draw from their own cycle, or from the cycle a pending
      // line was carried to; STOCK lines (stock added to an encargo and every
      // walk-in sale) use free stock of any cycle, oldest first.
      const ownCycle = item.source !== "STOCK";
      if (
        ownCycle &&
        lot.roundId !== item.order.roundId &&
        lot.roundId !== item.fulfillRoundId
      )
        continue;
      if (
        lot.productId !== item.productId ||
        (!anySupplier && lot.supplierId !== item.supplierId) ||
        decimal(lot.available).lte(0)
      )
        continue;
      const take = Prisma.Decimal.min(left, decimal(lot.available));
      await tx.stockAllocation.upsert({
        where: {
          receiptItemId_orderItemId: {
            receiptItemId: lot.id,
            orderItemId: item.id,
          },
        },
        create: { receiptItemId: lot.id, orderItemId: item.id, quantity: take },
        update: { quantity: { increment: take } },
      });
      lot.available = decimal(lot.available).sub(take).toString();
      left = left.sub(take);
    }
    need.set(item.id, left);
  };
  for (const item of items) {
    await fill(item, false);
    if (item.source === "STOCK" && need.get(item.id)!.gt(0))
      throw new ConflictException(
        "No hay suficiente producto libre. Actualiza el inventario.",
      );
  }
  for (const item of items)
    if (item.source !== "STOCK" && need.get(item.id)!.gt(0))
      await fill(item, true);
}
export async function releaseForEdit(
  tx: Prisma.TransactionClient,
  itemId: string,
  newQuantity: string,
) {
  const allocations = await tx.stockAllocation.findMany({
    where: { orderItemId: itemId },
  });
  const delivered = allocations.reduce(
    (s, a) => s.add(a.delivered),
    decimal(0),
  );
  if (delivered.gt(newQuantity))
    throw new BadRequestException("No puedes quitar cantidades ya entregadas.");
  // Preserve consumed lot history; release only the unfulfilled portion.
  for (const a of allocations) {
    if (a.delivered.isZero())
      await tx.stockAllocation.delete({ where: { id: a.id } });
    else
      await tx.stockAllocation.update({
        where: { id: a.id },
        data: { quantity: a.delivered },
      });
  }
}
// Marks reserved pounds as delivered, oldest receipt first, using only lots
// received by the delivery time.
export async function consumeReserved(
  tx: Prisma.TransactionClient,
  orderItemId: string,
  quantity: Prisma.Decimal.Value,
  deliveredAt: Date,
) {
  let need = decimal(quantity);
  const allocations = await tx.stockAllocation.findMany({
    where: { orderItemId },
    include: { receiptItem: { include: { receipt: true } } },
    orderBy: { receiptItem: { receipt: { receivedAt: "asc" } } },
  });
  for (const a of allocations) {
    if (a.receiptItem.receipt.receivedAt > deliveredAt) continue;
    const take = Prisma.Decimal.min(need, a.quantity.sub(a.delivered));
    if (take.gt(0))
      await tx.stockAllocation.update({
        where: { id: a.id },
        data: { delivered: { increment: take } },
      });
    need = need.sub(take);
    if (need.isZero()) break;
  }
  if (need.gt(0))
    throw new BadRequestException(
      "No hay suficiente producto recibido y reservado para esta entrega. Registra la recepción primero.",
    );
}
