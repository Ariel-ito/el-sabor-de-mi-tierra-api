import test from "node:test";
import assert from "node:assert/strict";
import { Entry, monthRange, recurringPeriods, summarize } from "../src/finance";
test("months follow Honduras time", () => {
  const { start, end } = monthRange("2026-12");
  assert.equal(start.toISOString(), "2026-12-01T06:00:00.000Z");
  assert.equal(end.toISOString(), "2027-01-01T06:00:00.000Z");
});
test("monthly recurring periods start on or after startsOn", () => {
  const periods = recurringPeriods(
    {
      frequency: "MONTHLY",
      day: 5,
      startsOn: new Date("2026-07-10T06:00:00Z"),
    },
    new Date("2026-10-04T12:00:00Z"),
  );
  assert.deepEqual(
    periods.map((p) => p.periodKey),
    ["2026-08", "2026-09"],
  );
});
test("weekly and biweekly periods land on the weekday", () => {
  const until = new Date("2026-10-04T23:00:00Z");
  // 2026-09-01 is a Tuesday; first Friday is 09-04.
  const weekly = recurringPeriods(
    { frequency: "WEEKLY", day: 5, startsOn: new Date("2026-09-01T06:00:00Z") },
    until,
  );
  assert.deepEqual(
    weekly.map((p) => p.periodKey),
    ["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25", "2026-10-02"],
  );
  const biweekly = recurringPeriods(
    {
      frequency: "BIWEEKLY",
      day: 5,
      startsOn: new Date("2026-09-01T06:00:00Z"),
    },
    until,
  );
  assert.deepEqual(
    biweekly.map((p) => p.periodKey),
    ["2026-09-04", "2026-09-18", "2026-10-02"],
  );
});
const entry = (e: Partial<Entry>): Entry => ({
  kind: "EXPENSE",
  status: "PAID",
  amount: "0",
  systemKey: null,
  inResult: true,
  categoryName: "Otros gastos",
  paidBy: "BUSINESS",
  personalMode: null,
  reimbursedAt: null,
  owner: null,
  recurring: false,
  ...e,
});
test("summary separates profit, owner money and cash", () => {
  const s = summarize([
    entry({
      kind: "INCOME",
      amount: "1000",
      systemKey: "SALE",
      categoryName: "Venta",
    }),
    entry({
      amount: "400",
      systemKey: "PRODUCT_PURCHASE",
      categoryName: "Compra de producto",
    }),
    entry({ amount: "50", categoryName: "Transporte", recurring: true }),
    // Owner paid and is owed it back.
    entry({
      amount: "30",
      paidBy: "ARIEL",
      personalMode: "REIMBURSE",
      categoryName: "Empaque",
    }),
    // Owner paid and gave it to the business.
    entry({
      amount: "20",
      paidBy: "MARIA",
      personalMode: "CONTRIBUTE",
      categoryName: "Empaque",
    }),
    entry({
      kind: "INCOME",
      amount: "200",
      systemKey: "OWNER_CONTRIBUTION",
      inResult: false,
      owner: "ARIEL",
      categoryName: "Aporte",
    }),
    entry({
      amount: "100",
      systemKey: "PROFIT_DISTRIBUTION",
      inResult: false,
      owner: "MARIA",
      categoryName: "Reparto",
    }),
    entry({ amount: "75", status: "PENDING", categoryName: "Servicios" }),
    entry({ amount: "999", status: "SKIPPED" }),
  ]);
  assert.equal(s.income, "1000.00");
  assert.equal(s.expense, "500.00");
  assert.equal(s.result, "500.00");
  assert.equal(s.distributed, "100.00");
  assert.equal(s.available, "400.00");
  assert.deepEqual(s.contributed, { ARIEL: "200.00", MARIA: "20.00" });
  assert.deepEqual(s.owedToOwners, { ARIEL: "30.00", MARIA: "0.00" });
  assert.equal(s.pendingRecurring, "75.00");
  // 1000 + 200 − 400 − 50 − 100; owner-paid items do not leave the till.
  assert.equal(s.cashExpected, "650.00");
  assert.equal(s.byCategory.find((c) => c.name === "Empaque")?.amount, "50.00");
  assert.equal(
    s.byCategory.find((c) => c.name === "Transporte")?.recurring,
    "50.00",
  );
});
test("a reimbursed personal payment leaves the till when repaid", () => {
  const s = summarize([
    entry({
      amount: "30",
      paidBy: "ARIEL",
      personalMode: "REIMBURSE",
      reimbursedAt: new Date(),
    }),
  ]);
  assert.equal(s.cashExpected, "-30.00");
  assert.equal(s.owedToOwnersTotal, "0.00");
});
