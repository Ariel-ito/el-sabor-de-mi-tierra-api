import test from "node:test";
import assert from "node:assert/strict";
import { cycleCosts, lineCost } from "../src/costing";
const lots = [
  {
    productId: "q",
    supplierId: "s",
    roundId: "r",
    quantity: "4",
    unitCost: "60",
  },
  {
    productId: "q",
    supplierId: "s",
    roundId: "r",
    quantity: "1",
    unitCost: "70",
  },
  {
    productId: "q",
    supplierId: "other",
    roundId: "r",
    quantity: "9",
    unitCost: "10",
  },
];
const item = (extra: any = {}) => ({
  productId: "q",
  supplierId: "s",
  quantity: "2",
  unitPrice: "90",
  estimatedUnitCost: "50",
  product: { name: "Queso" },
  ...extra,
});
test("assigned lots give real cost; the rest uses the cycle average", () => {
  const c = lineCost(
    item({
      allocations: [
        { quantity: "0.5", receiptItem: { effectiveUnitCost: "58" } },
      ],
    }),
    "r",
    lots,
  );
  assert.equal(c.lot.toString(), "0.5");
  assert.equal(c.cycle.toString(), "1.5");
  assert.equal(c.estimate.toString(), "0");
  assert.equal(c.cost.toString(), "122");
});
test("without cycle receipts the saved estimate fills in, else it is missing", () => {
  assert.equal(lineCost(item(), "other-round", lots).estimate.toString(), "2");
  const missing = lineCost(
    item({ estimatedUnitCost: null }),
    "other-round",
    lots,
  );
  assert.equal(missing.cost.toString(), "0");
  const view = cycleCosts(
    "x",
    [{ items: [item({ estimatedUnitCost: null })] }],
    [],
  );
  assert.equal(view.costing.unitCost, null);
  assert.equal(view.costing.marginPerLb, null);
  assert.equal(view.costing.costSources.missing, "2");
});
test("cycle view reports price, cost and margin per pound by product", () => {
  const view = cycleCosts(
    "r",
    [{ items: [item(), item({ quantity: "1", unitPrice: "96" })] }],
    lots,
  );
  const q = view.productCosts[0];
  assert.equal(q.quantity, "3");
  assert.equal(q.sales, "276.00");
  assert.equal(q.unitPrice, "92.00");
  assert.equal(q.unitCost, "62.00");
  assert.equal(q.marginPerLb, "30.00");
  assert.equal(q.costSources.cycle, "3");
});
