import test from "node:test";
import assert from "node:assert/strict";
import { allocateCustomerPayment } from "../src/customer-payments";

test("one payment clears the oldest balance and partially pays the next", () => {
  const debts = [
    { id: "new", createdAt: new Date("2026-10-28"), balance: "540" },
    { id: "old", createdAt: new Date("2026-10-22"), balance: "715" },
  ];
  assert.deepEqual(allocateCustomerPayment("1000", debts), {
    applied: "1000.00",
    excess: "0.00",
    payments: [
      { orderId: "old", amount: "715.00", balanceAfter: "0.00" },
      { orderId: "new", amount: "285.00", balanceAfter: "255.00" },
    ],
  });
  assert.equal(debts[0].id, "new", "does not reorder the source list");
});

test("centavos, paid balances, stable ties and excess are exact", () => {
  const date = new Date("2026-10-20");
  assert.deepEqual(
    allocateCustomerPayment("0.11", [
      { id: "b", createdAt: date, balance: "0.07" },
      { id: "paid", createdAt: new Date("2026-10-01"), balance: "0" },
      { id: "a", createdAt: date, balance: "0.03" },
    ]),
    {
      applied: "0.10",
      excess: "0.01",
      payments: [
        { orderId: "a", amount: "0.03", balanceAfter: "0.00" },
        { orderId: "b", amount: "0.07", balanceAfter: "0.00" },
      ],
    },
  );
});

test("a partial payment never touches newer debts", () => {
  assert.deepEqual(
    allocateCustomerPayment("0.01", [
      { id: "a", createdAt: new Date("2026-10-01"), balance: "20.15" },
      { id: "b", createdAt: new Date("2026-10-02"), balance: "10" },
    ]),
    {
      applied: "0.01",
      excess: "0.00",
      payments: [{ orderId: "a", amount: "0.01", balanceAfter: "20.14" }],
    },
  );
});
