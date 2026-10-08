import { Prisma } from "@prisma/client";
import { decimal, money, saleTotal } from "./math";
type D = Prisma.Decimal;
export type Lot = {
  productId: string;
  supplierId: string;
  roundId: string;
  quantity: Prisma.Decimal.Value;
  unitCost: Prisma.Decimal.Value;
  free?: Prisma.Decimal.Value;
  unit?: string;
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
export function cycleCosts(roundId: string, orders: any[], lots: Lot[]) {
  const rows = new Map<string, any>();
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
  for (const order of orders)
    for (const item of order.items) {
      const c = lineCost(item, roundId, lots);
      const sales = decimal(saleTotal(item));
      const isLb = (item.product.unit ?? "lb") === "lb";
      const row = rows.get(item.productId) || {
        productId: item.productId,
        name: item.product.name,
        unit: item.product.unit ?? "lb",
        sales: zero(),
        quantity: zero(),
        cost: zero(),
        lot: zero(),
        cycle: zero(),
        estimate: zero(),
      };
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
        ...view(r),
      })),
  };
}
