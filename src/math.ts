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
  payments: { orderBy: { paidAt: "asc" } },
  deliveries: { include: { items: true }, orderBy: { deliveredAt: "asc" } },
  items: { include: { product: true, supplier: true, allocations: true } },
} as const;
export const saleTotal = (item: any) =>
  item.totalAmount == null
    ? lineTotal(item.quantity, item.unitPrice)
    : money(item.totalAmount);
export function serializeOrder(order: any) {
  const items = order.items.map((item: any) => ({
    ...item,
    reservedQuantity: (item.allocations || [])
      .reduce(
        (s: Prisma.Decimal, a: any) => s.add(a.quantity).sub(a.delivered),
        decimal(0),
      )
      .toString(),
    deliveredQuantity: (item.allocations || [])
      .reduce((s: Prisma.Decimal, a: any) => s.add(a.delivered), decimal(0))
      .toString(),
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
  const total = items.reduce(
    (s: Prisma.Decimal, i: any) => s.add(i.lineTotal),
    decimal(0),
  );
  const { paid, balance, credit } = orderBalance(order);
  const delivered = items.reduce(
    (s: Prisma.Decimal, i: any) => s.add(i.deliveredQuantity),
    decimal(0),
  );
  const quantity = items.reduce(
    (s: Prisma.Decimal, i: any) => s.add(i.quantity),
    decimal(0),
  );
  return {
    ...order,
    paid: money(paid),
    balance: money(balance),
    credit: money(credit),
    paymentStatus: paid.gte(total) ? "PAID" : paid.gt(0) ? "PARTIAL" : "UNPAID",
    deliveryStatus: delivered.gte(quantity)
      ? "DELIVERED"
      : delivered.gt(0)
        ? "PARTIAL"
        : "ORDERED",
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
      if (item.source === "STOCK") continue;
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

export function orderBalance(order: any) {
  const total = order.items.reduce(
    (s: Prisma.Decimal, i: any) => s.add(saleTotal(i)),
    decimal(0),
  );
  const paid = (order.payments || [])
    .filter((p: any) => !p.voidedAt)
    .reduce((s: Prisma.Decimal, p: any) => s.add(p.amount), decimal(0));
  return {
    paid,
    balance: Prisma.Decimal.max(0, total.sub(paid)),
    credit: Prisma.Decimal.max(0, paid.sub(total)),
  };
}
const margin = (profit: Prisma.Decimal, sales: Prisma.Decimal) =>
  sales.isZero() ? null : money(profit.div(sales).mul(100));
export function metrics(orders: any[]) {
  let sales = decimal(0),
    costedSales = decimal(0),
    cost = decimal(0),
    quantity = decimal(0),
    collected = decimal(0),
    outstanding = decimal(0),
    credit = decimal(0),
    missing = 0;
  for (const order of orders) {
    for (const item of order.items) {
      const line = saleTotal(item);
      sales = sales.add(line);
      quantity = quantity.add(item.quantity);
      if (item.estimatedUnitCost == null) missing++;
      else {
        costedSales = costedSales.add(line);
        cost = cost.add(lineTotal(item.quantity, item.estimatedUnitCost));
      }
    }
    const b = orderBalance(order);
    collected = collected.add(b.paid);
    outstanding = outstanding.add(b.balance);
    credit = credit.add(b.credit);
  }
  const profit = sales.sub(cost);
  // With legacy lines lacking cost, report profit only over the costed share
  // and say how much of sales it covers; never treat missing cost as zero.
  const partial =
    missing && !costedSales.isZero()
      ? {
          sales: money(costedSales),
          estimatedCost: money(cost),
          estimatedProfit: money(costedSales.sub(cost)),
          margin: margin(costedSales.sub(cost), costedSales),
          coverage: money(costedSales.div(sales).mul(100)),
        }
      : null;
  return {
    partial,
    collected: money(collected),
    outstanding: money(outstanding),
    credit: money(credit),
    sales: money(sales),
    estimatedCost: missing ? null : money(cost),
    estimatedProfit: missing ? null : money(profit),
    margin: missing ? null : margin(profit, sales),
    quantity: quantity.toString(),
    orderCount: orders.length,
    customerCount: new Set(orders.map((o) => o.customerId)).size,
    averageOrder: orders.length ? money(sales.div(orders.length)) : "0.00",
    missingCostLines: missing,
  };
}
export function debtors(orders: any[]) {
  const rows = new Map<string, any>();
  for (const order of orders) {
    const { balance } = orderBalance(order);
    if (balance.isZero()) continue;
    const row = rows.get(order.customerId) || {
      id: order.customerId,
      name: order.customer.name,
      balance: decimal(0),
      orderCount: 0,
      oldestAt: order.createdAt,
    };
    row.balance = row.balance.add(balance);
    row.orderCount++;
    if (order.createdAt < row.oldestAt) row.oldestAt = order.createdAt;
    rows.set(order.customerId, row);
  }
  return [...rows.values()]
    .sort((a, b) => b.balance.comparedTo(a.balance))
    .map((r) => ({ ...r, balance: money(r.balance) }));
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
      debtors: debtors(selected),
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
