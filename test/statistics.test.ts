import test from "node:test";
import assert from "node:assert/strict";
import { metrics, statistics } from "../src/math";
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
