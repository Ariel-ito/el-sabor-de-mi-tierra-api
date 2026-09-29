import { Prisma } from "@prisma/client";
export const decimal = (value: Prisma.Decimal.Value) =>
  new Prisma.Decimal(value);
export const money = (value: Prisma.Decimal.Value) =>
  decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
export const lineTotal = (
  quantity: Prisma.Decimal.Value,
  price: Prisma.Decimal.Value,
) => money(decimal(quantity).mul(price));
export const orderInclude = {
  customer: true,
  items: { include: { product: true, supplier: true } },
} as const;
export function serializeOrder(order: any) {
  const items = order.items.map((item: any) => ({
    ...item,
    quantity: item.quantity.toString(),
    unitPrice: money(item.unitPrice),
    lineTotal: lineTotal(item.quantity, item.unitPrice),
  }));
  return {
    ...order,
    items,
    total: money(
      items.reduce(
        (sum: Prisma.Decimal, item: any) => sum.add(item.lineTotal),
        decimal(0),
      ),
    ),
  };
}
export function purchaseSummary(roundId: string, orders: any[]) {
  const groups = new Map<string, any>();
  for (const order of orders)
    for (const item of order.items) {
      if (!groups.has(item.supplierId))
        groups.set(item.supplierId, {
          supplierId: item.supplierId,
          supplierName: item.supplier.name,
          region: item.supplier.region,
          items: new Map(),
        });
      const group = groups.get(item.supplierId);
      if (!group.items.has(item.productId))
        group.items.set(item.productId, {
          productId: item.productId,
          productName: item.product.name,
          unit: "lb",
          quantity: decimal(0),
          estimatedUnitCost: money(item.product.estimatedCost),
        });
      const row = group.items.get(item.productId);
      row.quantity = row.quantity.add(item.quantity);
    }
  let totalQuantity = decimal(0),
    total = decimal(0);
  const result = [...groups.values()].map((g) => {
    let sub = decimal(0);
    const items = [...g.items.values()].map((i: any) => {
      const estimatedSubtotal = lineTotal(i.quantity, i.estimatedUnitCost);
      sub = sub.add(estimatedSubtotal);
      totalQuantity = totalQuantity.add(i.quantity);
      return { ...i, quantity: i.quantity.toString(), estimatedSubtotal };
    });
    total = total.add(sub);
    return { ...g, items, estimatedTotal: money(sub) };
  });
  return {
    roundId,
    groups: result,
    totalQuantity: totalQuantity.toString(),
    estimatedTotal: money(total),
  };
}
