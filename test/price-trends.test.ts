import test from "node:test";
import assert from "node:assert/strict";
import { productPrices } from "../src/price-trends";
import { cycleCosts } from "../src/costing";

const product = { name: "Mantequilla crema", unit: "lb" };
const supplier = { name: "Las Delicias" };
const invoice = (
  quantity: string,
  netTotal: string,
  extra: {
    roundId?: string;
    supplierId?: string;
    kind?: string;
    date?: string;
    productId?: string;
  } = {},
) => ({
  quantity,
  netTotal,
  receipt: {
    id: `r-${quantity}-${netTotal}`,
    invoice: `FAC-${netTotal}`,
    receivedAt: new Date(extra.date ?? "2026-11-19T20:00:00Z"),
  },
  purchaseItem: {
    productId: extra.productId ?? "p",
    product,
    purchase: {
      id: `buy-${netTotal}`,
      roundId: extra.roundId ?? "c9",
      supplierId: extra.supplierId ?? "s",
      supplier,
      kind: extra.kind ?? "PURCHASE",
    },
  },
});
const item = (quantity: string, unitPrice = "70", extra = {}) => ({
  productId: "p",
  product,
  supplierId: "s",
  supplier,
  quantity,
  unitPrice,
  ...extra,
});
const order = (items = [item("17")], extra = {}) => ({
  roundId: "c9",
  items,
  ...extra,
});

test("invoice prices stay at 56 while sold-lot costs blend old stock to 55.76", () => {
  const orders = [
    order([
      item("17", "70", {
        allocations: [
          { quantity: "2", receiptItem: { effectiveUnitCost: "54" } },
          { quantity: "15", receiptItem: { effectiveUnitCost: "56" } },
        ],
      }),
    ]),
  ];
  const receipts = [
    invoice("2", "108", { roundId: "c8" }),
    invoice("16", "896"),
  ];
  const [p] = productPrices("c9", orders, receipts);
  assert.equal(p.purchasedQuantity, "16");
  assert.equal(p.purchaseTotal, "896.00");
  assert.equal(p.purchaseUnitCost, "56.00");
  assert.equal(p.soldQuantity, "17");
  assert.equal(p.saleUnitPrice, "70.00");
  assert.equal(p.referenceMargin, "14.00");
  // The profitability calculation retains its actual lot costs.
  assert.equal(cycleCosts("c9", orders, []).productCosts[0].unitCost, "55.76");
});

test("multiple invoice prices are quantity weighted from exact net totals, after all discounts", () => {
  const [p] = productPrices(
    "c9",
    [],
    [
      invoice("3", "180", { date: "2026-11-20T20:00:00Z" }),
      invoice("1", "53.99"),
    ],
  );
  assert.equal(p.purchaseUnitCost, "58.50");
  assert.equal(p.purchaseMin, "53.99");
  assert.equal(p.purchaseMax, "60.00");
  assert.equal(p.purchaseTotal, "233.99");
  assert.equal(p.invoices.length, 2);
  assert.equal(p.invoices[0].invoice, "FAC-53.99");
  assert.equal(p.saleUnitPrice, null);
  assert.equal(p.referenceMargin, null);
});

test("suppliers and different products with identical names never blend", () => {
  const prices = productPrices(
    "c9",
    [order()],
    [
      invoice("16", "896"),
      invoice("2", "120", { supplierId: "other" }),
      invoice("1", "85", { productId: "same-name" }),
    ],
  );
  assert.equal(prices.length, 3);
  const other = prices.find((p) => p.supplierId === "other")!;
  assert.equal(other.purchaseUnitCost, "60.00");
  assert.equal(other.soldQuantity, "0");
  assert.equal(other.saleUnitPrice, null);
  assert.equal(
    prices.find((p) => p.productId === "same-name")!.purchaseUnitCost,
    "85.00",
  );
});

test("purchased extras appear without sales; assemblies and other cycles are excluded", () => {
  const prices = productPrices(
    "c9",
    [],
    [
      invoice("16", "896"),
      invoice("1", "20", { kind: "ASSEMBLY", productId: "combo" }),
      invoice("10", "400", { roundId: "c8" }),
    ],
  );
  assert.equal(prices.length, 1);
  assert.equal(prices[0].purchasedQuantity, "16");
  assert.equal(prices[0].invoices.length, 1);
});

test("selling carried stock without a new purchase leaves cycle purchase price empty", () => {
  const [p] = productPrices(
    "c9",
    [
      order(),
      order([item("5", "500")], { cancelledAt: new Date() }),
      order([item("10", "10")], { roundId: "c8" }),
    ],
    [invoice("2", "108", { roundId: "c8" })],
  );
  assert.equal(p.purchaseUnitCost, null);
  assert.equal(p.purchasedQuantity, "0");
  assert.equal(p.saleUnitPrice, "70.00");
  assert.equal(p.soldQuantity, "17");
  assert.equal(p.referenceMargin, null);
});

test("half-pound premiums and agreed totals define the sale price, not the catalog or rounded unit equivalent", () => {
  const [p] = productPrices(
    "c9",
    [order([item("1", "45"), item("0.5", "45", { totalAmount: "25" })])],
    [invoice("2", "60")],
  );
  assert.equal(p.sales, "70.00");
  assert.equal(p.saleUnitPrice, "46.67");
  assert.equal(p.saleMin, "45.00");
  assert.equal(p.saleMax, "50.00");
  assert.equal(p.referenceMargin, "16.67");
  const [fixed] = productPrices(
    "c9",
    [order([item("3", "33.33", { totalAmount: "100" })])],
    [],
  );
  assert.equal(fixed.sales, "100.00");
  assert.equal(fixed.saleUnitPrice, "33.33");
});
