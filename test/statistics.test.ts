import test from "node:test";
import assert from "node:assert/strict";
import { debtors, metrics, statistics } from "../src/math";
test("profit uses rounded line costs and sales, including losses and zero sales", () => {
  const report = metrics([
    {
      customerId: "a",
      items: [
        { quantity: "1.5", unitPrice: "70", estimatedUnitCost: "53" },
        { quantity: ".5", unitPrice: "80", estimatedUnitCost: "60" },
      ],
    },
  ]);
  assert.equal(report.sales, "145.00");
  assert.equal(report.estimatedProfit, "35.50");
  assert.equal(report.margin, "24.48");
  assert.equal(
    metrics([
      { items: [{ quantity: "1", unitPrice: "0", estimatedUnitCost: "5" }] },
    ]).margin,
    null,
  );
  assert.equal(
    metrics([
      { items: [{ quantity: "1", unitPrice: "0", estimatedUnitCost: "5" }] },
    ]).estimatedProfit,
    "-5.00",
  );
});
test("legacy missing costs never become zero-cost profits", () => {
  const report = metrics([
    { items: [{ quantity: 1, unitPrice: 70, estimatedUnitCost: null }] },
  ]);
  assert.equal(report.sales, "70.00");
  assert.equal(report.estimatedProfit, null);
  assert.equal(report.estimatedCost, null);
  assert.equal(report.missingCostLines, 1);
});
test("cycle reports count unique customers and keep empty cycles", () => {
  const item = {
    productId: "p",
    product: { name: "Crema" },
    quantity: "0.5",
    unitPrice: "53.01",
    estimatedUnitCost: "50.01",
  };
  const orders = [
    {
      id: "1",
      roundId: "r",
      customerId: "c",
      customer: { name: "Cliente" },
      items: [item, item],
    },
  ];
  const result = statistics([{ id: "r" }, { id: "empty" }], orders);
  assert.equal(result.overall.sales, "53.02");
  assert.equal(result.overall.estimatedCost, "50.02");
  assert.equal(result.overall.customers[0].orderCount, 1);
  assert.equal(result.cycles[1].orderCount, 0);
});
test("partial profit covers only costed lines and reports coverage", () => {
  const report = metrics([
    {
      items: [
        { quantity: "1", unitPrice: "75", estimatedUnitCost: "50" },
        { quantity: "1", unitPrice: "25", estimatedUnitCost: null },
      ],
    },
  ]);
  assert.equal(report.estimatedProfit, null);
  assert.deepEqual(report.partial, {
    sales: "75.00",
    estimatedCost: "50.00",
    estimatedProfit: "25.00",
    margin: "33.33",
    coverage: "75.00",
  });
  assert.equal(
    metrics([
      { items: [{ quantity: "1", unitPrice: "70", estimatedUnitCost: null }] },
    ]).partial,
    null,
  );
  assert.equal(
    metrics([
      { items: [{ quantity: "1", unitPrice: "70", estimatedUnitCost: "5" }] },
    ]).partial,
    null,
  );
});
test("collections ignore voided payments and keep credit apart", () => {
  const item = { quantity: "1", unitPrice: "100", estimatedUnitCost: "60" };
  const report = metrics([
    {
      items: [item],
      payments: [{ amount: "40" }, { amount: "30", voidedAt: new Date() }],
    },
    { items: [item], payments: [{ amount: "120" }] },
    { items: [item] },
  ]);
  assert.equal(report.collected, "160.00");
  assert.equal(report.outstanding, "160.00");
  assert.equal(report.credit, "20.00");
});
test("debtors group pending balances by customer, largest first", () => {
  const item = { quantity: "1", unitPrice: "50" };
  const order = (id: string, customerId: string, day: number, paid = "0") => ({
    id,
    customerId,
    customer: { name: customerId.toUpperCase() },
    createdAt: new Date(2026, 8, day),
    items: [item],
    payments: [{ amount: paid }],
  });
  const rows = debtors([
    order("1", "a", 3),
    order("2", "b", 2),
    order("3", "b", 1, "20"),
    order("4", "c", 1, "50"),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.balance, r.orderCount]),
    [
      ["b", "80.00", 2],
      ["a", "50.00", 1],
    ],
  );
  assert.deepEqual(rows[0].oldestAt, new Date(2026, 8, 1));
});
