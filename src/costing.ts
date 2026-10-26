import { Prisma } from "@prisma/client";
import { decimal, money, orderBalance, saleTotal, shippingOf } from "./math";
type D = Prisma.Decimal;
export type Lot = {
  productId: string;
  supplierId: string;
  roundId: string;
  quantity: Prisma.Decimal.Value;
  unitCost: Prisma.Decimal.Value;
  free?: Prisma.Decimal.Value;
  unit?: string;
  // For products lost or given away without being sold in the cycle.
  name?: string;
  category?: string;
  withdrawals?: { reason: string; quantity: Prisma.Decimal.Value }[];
};
// What a cycle bought that left without being sold, valued at lot cost.
// `pounds` counts pound products only; `quantities` has every unit.
export function absorbed(roundId: string, lots: Lot[]) {
  const sum = () => ({
    pounds: decimal(0),
    cost: decimal(0),
    quantities: {} as Record<string, D>,
  });
  const add = (
    r: ReturnType<typeof sum>,
    unit = "lb",
    q: Prisma.Decimal.Value,
  ) => {
    if (unit === "lb") r.pounds = r.pounds.add(q);
    r.quantities[unit] = (r.quantities[unit] ?? decimal(0)).add(q);
  };
  const by: Record<string, ReturnType<typeof sum>> = {
    LOSS: sum(),
    SAMPLE: sum(),
    PERSONAL: sum(),
  };
  const kept = sum();
  for (const lot of lots) {
    if (lot.roundId !== roundId) continue;
    for (const w of lot.withdrawals || []) {
      const row = by[w.reason];
      if (!row) continue;
      add(row, lot.unit, w.quantity);
      row.cost = row.cost.add(decimal(w.quantity).mul(lot.unitCost));
    }
    if (lot.free !== undefined && decimal(lot.free).gt(0)) {
      add(kept, lot.unit, lot.free);
      kept.cost = kept.cost.add(decimal(lot.free).mul(lot.unitCost));
    }
  }
  const view = (r: ReturnType<typeof sum>) => ({
    pounds: r.pounds.toString(),
    cost: money(r.cost),
    quantities: Object.fromEntries(
      Object.entries(r.quantities).map(([u, q]) => [u, q.toString()]),
    ),
  });
  return {
    loss: view(by.LOSS),
    sample: view(by.SAMPLE),
    personal: view(by.PERSONAL),
    total: money(by.LOSS.cost.add(by.SAMPLE.cost).add(by.PERSONAL.cost)),
    kept: view(kept),
  };
}
// Agreed costing rule: the lot actually assigned to the line is its real cost;
// any unassigned pounds use that cycle's average receipt cost for the same
// product and supplier, then the catalog estimate saved on the line.
export function lineCost(item: any, roundId: string, lots: Lot[]) {
  const quantity = decimal(item.quantity);
  let lot = decimal(0),
    cost = decimal(0);
  for (const a of item.allocations || []) {
    if (!a.receiptItem) continue;
    lot = lot.add(a.quantity);
    cost = cost.add(decimal(a.quantity).mul(a.receiptItem.effectiveUnitCost));
  }
  lot = Prisma.Decimal.min(lot, quantity);
  const rest = quantity.sub(lot);
  let cycle = decimal(0),
    estimate = decimal(0);
  if (rest.gt(0)) {
    const same = lots.filter(
      (l) =>
        l.roundId === roundId &&
        l.productId === item.productId &&
        l.supplierId === item.supplierId,
    );
    const q = same.reduce((s, l) => s.add(l.quantity), decimal(0));
    if (q.gt(0)) {
      const value = same.reduce(
        (s, l) => s.add(decimal(l.quantity).mul(l.unitCost)),
        decimal(0),
      );
      cycle = rest;
      cost = cost.add(rest.mul(value.div(q)));
    } else if (item.estimatedUnitCost != null) {
      estimate = rest;
      cost = cost.add(rest.mul(item.estimatedUnitCost));
    }
  }
  return { quantity, cost, lot, cycle, estimate };
}
const perLb = (value: D, quantity: D) =>
  quantity.isZero() ? null : money(value.div(quantity));
function summarize(
  sales: D,
  quantity: D,
  cost: D,
  lot: D,
  cycle: D,
  estimate: D,
) {
  const costed = lot.add(cycle).add(estimate);
  const unitPrice = perLb(sales, quantity);
  const unitCost = perLb(cost, costed);
  return {
    quantity: quantity.toString(),
    sales: money(sales),
    cost: money(cost),
    unitPrice,
    unitCost,
    marginPerLb:
      unitPrice === null || unitCost === null
        ? null
        : money(decimal(unitPrice).sub(unitCost)),
    costSources: {
      lot: lot.toString(),
      cycle: cycle.toString(),
      estimate: estimate.toString(),
      missing: quantity.sub(costed).toString(),
    },
  };
}
export function cycleCosts(roundId: string, orders: any[], allLots: Lot[]) {
  // Only this cycle's lots matter below; filtering once keeps it fast.
  const lots = allLots.filter((l) => l.roundId === roundId);
  const rows = new Map<string, any>();
  const buyers = new Map<string, any>();
  const zero = () => decimal(0);
  const total = {
    sales: zero(),
    quantity: zero(),
    cost: zero(),
    lot: zero(),
    cycle: zero(),
    estimate: zero(),
  };
  // Per-pound figures only make sense over pound products.
  const pounds = {
    sales: zero(),
    quantity: zero(),
    cost: zero(),
    lot: zero(),
    cycle: zero(),
    estimate: zero(),
  };
  for (const order of orders) {
    // What each customer bought, what it cost and what they still owe.
    const buyer =
      order.cancelledAt || !order.customerId || !order.items.length
        ? null
        : buyers.get(order.customerId) || {
            customerId: order.customerId,
            name: order.customer?.name ?? "",
            orders: 0,
            sales: zero(),
            cost: zero(),
            missing: zero(),
            shipping: zero(),
            balance: zero(),
          };
    if (buyer) {
      buyer.orders++;
      buyer.shipping = buyer.shipping.add(shippingOf(order));
      buyer.balance = buyer.balance.add(orderBalance(order).balance);
      buyers.set(order.customerId, buyer);
    }
    for (const item of order.items) {
      const c = lineCost(item, roundId, lots);
      const sales = decimal(saleTotal(item));
      if (buyer) {
        buyer.sales = buyer.sales.add(sales);
        buyer.cost = buyer.cost.add(c.cost);
        buyer.missing = buyer.missing.add(
          c.quantity.sub(c.lot).sub(c.cycle).sub(c.estimate),
        );
      }
      const isLb = (item.product.unit ?? "lb") === "lb";
      const row = rows.get(item.productId) || {
        productId: item.productId,
        name: item.product.name,
        unit: item.product.unit ?? "lb",
        category: item.product.category?.name ?? "Sin categoría",
        sales: zero(),
        quantity: zero(),
        cost: zero(),
        lot: zero(),
        cycle: zero(),
        estimate: zero(),
        // Order lines with this product: how often it is asked for, in any unit.
        orders: 0,
      };
      row.orders++;
      for (const t of isLb ? [row, total, pounds] : [row, total]) {
        t.sales = t.sales.add(sales);
        t.quantity = t.quantity.add(c.quantity);
        t.cost = t.cost.add(c.cost);
        t.lot = t.lot.add(c.lot);
        t.cycle = t.cycle.add(c.cycle);
        t.estimate = t.estimate.add(c.estimate);
      }
      rows.set(item.productId, row);
    }
  }
  // Each product's loss and samples, at the cost of the cycle's lots.
  const wasted = new Map<string, { loss: D; sample: D }>();
  for (const lot of lots) {
    if (lot.roundId !== roundId) continue;
    for (const w of lot.withdrawals || []) {
      if (w.reason !== "LOSS" && w.reason !== "SAMPLE") continue;
      const row = wasted.get(lot.productId) ?? { loss: zero(), sample: zero() };
      const cost = decimal(w.quantity).mul(lot.unitCost);
      if (w.reason === "LOSS") row.loss = row.loss.add(cost);
      else row.sample = row.sample.add(cost);
      wasted.set(lot.productId, row);
      if (!rows.has(lot.productId) && lot.name)
        rows.set(lot.productId, {
          productId: lot.productId,
          name: lot.name,
          unit: lot.unit ?? "lb",
          category: lot.category ?? "Sin categoría",
          sales: zero(),
          quantity: zero(),
          cost: zero(),
          lot: zero(),
          cycle: zero(),
          estimate: zero(),
          orders: 0,
        });
    }
  }
  const view = (r: typeof total) =>
    summarize(r.sales, r.quantity, r.cost, r.lot, r.cycle, r.estimate);
  const lost = absorbed(roundId, lots);
  const all = view(total),
    lb = view(pounds);
  // Money and cost coverage over everything; per-pound prices over pounds.
  const costing = {
    ...all,
    quantity: lb.quantity,
    unitPrice: lb.unitPrice,
    unitCost: lb.unitCost,
    marginPerLb: lb.marginPerLb,
  };
  return {
    absorbed: lost,
    // Agreed sales minus cost of what was sold and of what was lost or given.
    result:
      costing.unitCost === null ||
      !decimal(costing.costSources.missing).isZero()
        ? null
        : money(total.sales.sub(total.cost).sub(lost.total)),
    costing,
    productCosts: [...rows.values()]
      .sort((a, b) => b.sales.comparedTo(a.sales))
      .map((r) => ({
        productId: r.productId,
        name: r.name,
        unit: r.unit,
        category: r.category,
        orders: r.orders,
        ...view(r),
        loss: money(wasted.get(r.productId)?.loss ?? zero()),
        sample: money(wasted.get(r.productId)?.sample ?? zero()),
      })),
    customerCosts: [...buyers.values()]
      .sort((a, b) => b.sales.comparedTo(a.sales))
      .map((r) => ({
        customerId: r.customerId,
        name: r.name,
        orders: r.orders,
        sales: money(r.sales),
        // Null while some of what they bought has no cost yet.
        cost: r.missing.gt(0) ? null : money(r.cost),
        shipping: money(r.shipping),
        balance: money(r.balance),
      })),
  };
}
