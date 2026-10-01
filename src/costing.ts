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
  withdrawals?: { reason: string; quantity: Prisma.Decimal.Value }[];
};
// Pounds a cycle bought that left without being sold, valued at lot cost.
export function absorbed(roundId: string, lots: Lot[]) {
  const sum = () => ({ pounds: decimal(0), cost: decimal(0) });
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
      row.pounds = row.pounds.add(w.quantity);
      row.cost = row.cost.add(decimal(w.quantity).mul(lot.unitCost));
    }
    if (lot.free !== undefined && decimal(lot.free).gt(0)) {
      kept.pounds = kept.pounds.add(lot.free);
      kept.cost = kept.cost.add(decimal(lot.free).mul(lot.unitCost));
    }
  }
  const view = (r: ReturnType<typeof sum>) => ({
    pounds: r.pounds.toString(),
    cost: money(r.cost),
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
  for (const order of orders)
    for (const item of order.items) {
      const c = lineCost(item, roundId, lots);
      const sales = decimal(saleTotal(item));
      const row = rows.get(item.productId) || {
        productId: item.productId,
        name: item.product.name,
        sales: zero(),
        quantity: zero(),
        cost: zero(),
        lot: zero(),
        cycle: zero(),
        estimate: zero(),
      };
      for (const t of [row, total]) {
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
  const costing = view(total);
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
      .map((r) => ({ productId: r.productId, name: r.name, ...view(r) })),
  };
}
