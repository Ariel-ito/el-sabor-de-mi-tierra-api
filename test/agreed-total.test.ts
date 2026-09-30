import { test } from "node:test";
import assert from "node:assert/strict";
import { metrics, saleTotal } from "../src/math";
test("agreed totals preserve half-pound premiums and non-divisible cents", () => {
  assert.equal(
    saleTotal({ quantity: "0.5", unitPrice: "50", totalAmount: "25" }),
    "25.00",
  );
  const item = {
    quantity: "3",
    unitPrice: "33.33",
    totalAmount: "100",
    estimatedUnitCost: "20",
  };
  assert.equal(saleTotal(item), "100.00");
  const m = metrics([{ customerId: "1", items: [item] }]);
  assert.equal(m.sales, "100.00");
  assert.equal(m.estimatedProfit, "40.00");
  assert.equal(saleTotal({ ...item, totalAmount: "0" }), "0.00");
  assert.equal(saleTotal({ ...item, totalAmount: null }), "99.99");
});
