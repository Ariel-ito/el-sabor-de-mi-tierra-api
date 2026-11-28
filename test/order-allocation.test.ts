import test from "node:test";
import assert from "node:assert/strict";
import { stockFirstWithinOrders } from "../src/order-allocation";

test("a split order reserves stock before its preorder regardless of line IDs", () => {
  const items = [
    { orderId: "same", id: "a", source: "PREORDER" },
    { orderId: "same", id: "z", source: "STOCK" },
  ];
  assert.deepEqual(
    stockFirstWithinOrders(items).map((i) => i.id),
    ["z", "a"],
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ["a", "z"],
  );
});
test("stock in a newer order never jumps ahead of an older customer's preorder", () => {
  const items = [
    { orderId: "old", id: "a", source: "PREORDER" },
    { orderId: "new", id: "b", source: "PREORDER" },
    { orderId: "new", id: "c", source: "STOCK" },
  ];
  assert.deepEqual(
    stockFirstWithinOrders(items).map((i) => i.id),
    ["a", "c", "b"],
  );
});
test("equal timestamps and interleaved IDs keep each customer's stock and preorder together", () => {
  const items = [
    { orderId: "first", id: "a", source: "PREORDER" },
    { orderId: "second", id: "b", source: "STOCK" },
    { orderId: "first", id: "c", source: "STOCK" },
    { orderId: "second", id: "d", source: "PREORDER" },
  ];
  assert.deepEqual(
    stockFirstWithinOrders(items).map((i) => i.id),
    ["c", "a", "b", "d"],
  );
});
