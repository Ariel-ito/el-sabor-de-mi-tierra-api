import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateDiscount } from "../src/purchases";
test("global discounts reconcile exact cents with stable remainder allocation", () => {
  assert.deepEqual(allocateDiscount(["1.00", "1.00", "1.00"], "1.00"), [
    "0.34",
    "0.33",
    "0.33",
  ]);
  assert.deepEqual(allocateDiscount(["1134", "270", "324"], "32"), [
    "21.00",
    "5.00",
    "6.00",
  ]);
  assert.deepEqual(allocateDiscount(["0", "0"], "0"), ["0.00", "0.00"]);
  assert.throws(() => allocateDiscount(["10"], "10.01"));
});
