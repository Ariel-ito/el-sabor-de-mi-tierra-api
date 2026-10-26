import test from "node:test";
import assert from "node:assert/strict";
import { extraSuggestions } from "../src/extra";
const products = [
  { id: "q", name: "Quesillo", unit: "lb" },
  { id: "b", name: "Bote", unit: "bote" },
  { id: "z", name: "Nada", unit: "lb" },
];
test("the extra is the average used beyond encargos, rounded up to what can be bought", () => {
  const rows = extraSuggestions(
    ["c1", "c2", "c3", "c4"],
    [
      { roundId: "c1", productId: "q", kind: "sold", quantity: "2" },
      { roundId: "c1", productId: "q", kind: "loss", quantity: "0.5" },
      { roundId: "c2", productId: "q", kind: "stock", quantity: "1.5" },
      { roundId: "c3", productId: "q", kind: "sample", quantity: "0.5" },
      { roundId: "c3", productId: "q", kind: "personal", quantity: "0.5" },
      { roundId: "c2", productId: "b", kind: "sold", quantity: "1" },
      { roundId: "other", productId: "q", kind: "sold", quantity: "50" },
    ],
    products,
  );
  const q = rows.find((r) => r.productId === "q")!;
  // 5 lb over 4 cycles = 1.25 lb, up to the next half pound.
  assert.equal(q.average, "1.25");
  assert.equal(q.suggested, "1.5");
  assert.deepEqual(
    q.history.map((h) => h.total),
    ["2.5", "1.5", "1", "0"],
  );
  assert.equal(q.history[0].sold, "2");
  // A quarter of a bote per cycle still means buying a whole one.
  assert.equal(rows.find((r) => r.productId === "b")!.suggested, "1");
  assert.equal(
    rows.some((r) => r.productId === "z"),
    false,
  );
});
test("with fewer than two earlier cycles there is no suggestion", () => {
  assert.deepEqual(
    extraSuggestions(
      ["c1"],
      [{ roundId: "c1", productId: "q", kind: "sold", quantity: "3" }],
      products,
    ),
    [],
  );
});
