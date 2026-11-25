import test from "node:test";
import assert from "node:assert/strict";
import { settlePayment } from "../src/settlement";
import { allocateCustomerPayment } from "../src/customer-payments";
test("one received amount has exactly one destination for its excess", () => {
  assert.throws(() => settlePayment("200", "185"));
  for (const disposition of ["TIP", "CREDIT", "CHANGE"] as const) {
    const s = settlePayment("200", "185", disposition);
    assert.equal(s.amount, "185.00");
    assert.equal(s.receivedAmount, "200.00");
    assert.equal(s.tipAmount, disposition === "TIP" ? "15.00" : "0.00");
    assert.equal(s.creditAmount, disposition === "CREDIT" ? "15.00" : "0.00");
    assert.equal(s.changeAmount, disposition === "CHANGE" ? "15.00" : "0.00");
  }
});
test("partial, exact, centavo and legacy-credit payments retain their meaning", () => {
  assert.equal(settlePayment("0.11", "0.10", "TIP").tipAmount, "0.01");
  assert.equal(settlePayment("80", "185").amount, "80.00");
  assert.equal(settlePayment("185", "185", "TIP").tipAmount, "0.00");
  assert.equal(
    settlePayment("200", "185", undefined, true).creditAmount,
    "15.00",
  );
  assert.throws(() => settlePayment("200", "185", "TIP", true));
  assert.throws(() => settlePayment("0", "185", "TIP"));
  assert.throws(() => settlePayment("10", "0", "TIP"));
});
test("tip cannot be applied to the next debt or inflate the order payment", () => {
  const debts = [
    { id: "old", createdAt: new Date("2026-10-01"), balance: "100" },
    { id: "new", createdAt: new Date("2026-11-01"), balance: "85" },
  ];
  const plan = allocateCustomerPayment("200", debts),
    s = settlePayment("200", "185", "TIP");
  assert.deepEqual(
    plan.payments.map((p) => p.amount),
    ["100.00", "85.00"],
  );
  assert.equal(s.amount, plan.applied);
  assert.equal(s.tipAmount, plan.excess);
});
