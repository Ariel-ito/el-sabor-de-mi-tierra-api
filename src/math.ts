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
export const saleTotal = (item: any) =>
  item.totalAmount == null
    ? lineTotal(item.quantity, item.unitPrice)
    : money(item.totalAmount);
export function serializeOrder(order: any) {
  const items = order.items.map((item: any) => ({
    ...item,
    quantity: item.quantity.toString(),
    unitPrice: money(item.unitPrice),
    totalAmount: item.totalAmount == null ? null : money(item.totalAmount),
    lineTotal: saleTotal(item),
    estimatedUnitCost:
      item.estimatedUnitCost == null ? null : money(item.estimatedUnitCost),
    estimatedLineCost:
      item.estimatedUnitCost == null
        ? null
        : lineTotal(item.quantity, item.estimatedUnitCost),
  }));
  return {
    ...order,
    items,
    profitability: metrics([{ ...order, items }]),
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

export function metrics(orders: any[]) {
  let sales = decimal(0),
    cost = decimal(0),
    quantity = decimal(0),
    missing = 0;
  for (const order of orders)
    for (const item of order.items) {
      sales = sales.add(saleTotal(item));
      quantity = quantity.add(item.quantity);
      if (item.estimatedUnitCost == null) missing++;
      else cost = cost.add(lineTotal(item.quantity, item.estimatedUnitCost));
    }
  const profit = sales.sub(cost);
  return {
    sales: money(sales),
    estimatedCost: missing ? null : money(cost),
    estimatedProfit: missing ? null : money(profit),
    margin:
      missing || sales.isZero() ? null : money(profit.div(sales).mul(100)),
    quantity: quantity.toString(),
    orderCount: orders.length,
    customerCount: new Set(orders.map((o) => o.customerId)).size,
    averageOrder: orders.length ? money(sales.div(orders.length)) : "0.00",
    missingCostLines: missing,
  };
}
export function statistics(rounds: any[], orders: any[]) {
  function rank(selected: any[], kind: "product" | "customer") {
    const rows = new Map<string, any>();
    for (const order of selected)
      for (const item of order.items) {
        const id = kind === "product" ? item.productId : order.customerId;
        if (!rows.has(id))
          rows.set(id, {
            id,
            name: kind === "product" ? item.product.name : order.customer.name,
            sales: decimal(0),
            quantity: decimal(0),
            orders: new Set<string>(),
          });
        const row = rows.get(id);
        row.sales = row.sales.add(saleTotal(item));
        row.quantity = row.quantity.add(item.quantity);
        row.orders.add(order.id);
      }
    return [...rows.values()]
      .sort((a, b) => b.sales.comparedTo(a.sales))
      .map((r) => ({
        id: r.id,
        name: r.name,
        sales: money(r.sales),
        quantity: r.quantity.toString(),
        orderCount: r.orders.size,
      }));
  }
  function report(selected: any[]) {
    return {
      ...metrics(selected),
      products: rank(selected, "product"),
      customers: rank(selected, "customer"),
    };
  }
  return {
    overall: report(orders),
    cycles: rounds.map((r) => ({
      id: r.id,
      name: r.name,
      opensAt: r.opensAt,
      closesAt: r.closesAt,
      ...report(orders.filter((o) => o.roundId === r.id)),
    })),
  };
}
