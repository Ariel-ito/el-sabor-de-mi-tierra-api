import { Prisma } from "@prisma/client";
import { decimal, money, saleTotal } from "./math";

type Product = {
  name: string;
  unit?: string | null;
  category?: { name: string } | null;
};
type Supplier = { name: string };
type Order = {
  roundId: string;
  cancelledAt?: Date | null;
  items: {
    productId: string;
    product: Product;
    supplierId: string;
    supplier: Supplier;
    quantity: Prisma.Decimal.Value;
    unitPrice: Prisma.Decimal.Value;
    totalAmount?: Prisma.Decimal.Value | null;
  }[];
};
type ReceiptLine = {
  quantity: Prisma.Decimal.Value;
  netTotal: Prisma.Decimal.Value;
  purchaseItem: {
    productId: string;
    product: Product;
    purchase: {
      id: string;
      roundId: string;
      supplierId: string;
      supplier: Supplier;
      kind: string;
    };
  };
  receipt: { id: string; invoice: string; receivedAt: Date };
};
type Invoice = {
  receiptId: string;
  purchaseId: string;
  invoice: string;
  receivedAt: Date;
  quantity: string;
  total: string;
  unitCost: string;
};
type Range = { min: Prisma.Decimal | null; max: Prisma.Decimal | null };
const extend = (range: Range, value: Prisma.Decimal) => {
  range.min = range.min === null ? value : Prisma.Decimal.min(range.min, value);
  range.max = range.max === null ? value : Prisma.Decimal.max(range.max, value);
};

// Commercial prices by product and registered supplier. Purchases belong to
// the purchase's cycle, including extra stock; allocations from other cycles
// affect profitability but must never rewrite this invoice-price history.
export function productPrices(
  roundId: string,
  orders: Order[],
  receipts: ReceiptLine[],
) {
  const rows = new Map<
    string,
    {
      productId: string;
      name: string;
      unit: string;
      category: string;
      supplierId: string;
      supplierName: string;
      purchasedQuantity: Prisma.Decimal;
      purchaseTotal: Prisma.Decimal;
      soldQuantity: Prisma.Decimal;
      sales: Prisma.Decimal;
      purchaseRange: Range;
      saleRange: Range;
      invoices: Invoice[];
    }
  >();
  const rowFor = (
    productId: string,
    product: Product,
    supplierId: string,
    supplier: Supplier,
  ) => {
    const key = `${productId}:${supplierId}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        productId,
        name: product.name,
        unit: product.unit ?? "lb",
        category: product.category?.name ?? "Sin categoría",
        supplierId,
        supplierName: supplier.name,
        purchasedQuantity: decimal(0),
        purchaseTotal: decimal(0),
        soldQuantity: decimal(0),
        sales: decimal(0),
        purchaseRange: { min: null, max: null },
        saleRange: { min: null, max: null },
        invoices: [],
      };
      rows.set(key, row);
    }
    return row;
  };
  for (const r of receipts) {
    const p = r.purchaseItem.purchase;
    const q = decimal(r.quantity);
    if (p.roundId !== roundId || p.kind !== "PURCHASE" || q.lte(0)) continue;
    const row = rowFor(
      r.purchaseItem.productId,
      r.purchaseItem.product,
      p.supplierId,
      p.supplier,
    );
    const total = decimal(r.netTotal),
      cost = total.div(q);
    row.purchasedQuantity = row.purchasedQuantity.add(q);
    row.purchaseTotal = row.purchaseTotal.add(total);
    extend(row.purchaseRange, cost);
    row.invoices.push({
      receiptId: r.receipt.id,
      purchaseId: p.id,
      invoice: r.receipt.invoice,
      receivedAt: r.receipt.receivedAt,
      quantity: q.toString(),
      total: money(total),
      unitCost: money(cost),
    });
  }
  for (const o of orders) {
    if (o.roundId !== roundId || o.cancelledAt) continue;
    for (const i of o.items) {
      const q = decimal(i.quantity);
      if (q.lte(0)) continue;
      const row = rowFor(i.productId, i.product, i.supplierId, i.supplier);
      // An agreed line total takes precedence over its rounded equivalent
      // unitPrice, including half-pound premiums and special prices.
      const sales = decimal(saleTotal(i));
      row.soldQuantity = row.soldQuantity.add(q);
      row.sales = row.sales.add(sales);
      extend(row.saleRange, sales.div(q));
    }
  }
  return [...rows.values()]
    .map((r) => {
      const cost = r.purchasedQuantity.gt(0)
        ? r.purchaseTotal.div(r.purchasedQuantity)
        : null;
      const price = r.soldQuantity.gt(0) ? r.sales.div(r.soldQuantity) : null;
      return {
        productId: r.productId,
        name: r.name,
        unit: r.unit,
        category: r.category,
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        purchasedQuantity: r.purchasedQuantity.toString(),
        purchaseTotal: money(r.purchaseTotal),
        soldQuantity: r.soldQuantity.toString(),
        sales: money(r.sales),
        purchaseUnitCost: cost === null ? null : money(cost),
        saleUnitPrice: price === null ? null : money(price),
        purchaseMin:
          r.purchaseRange.min === null ? null : money(r.purchaseRange.min),
        purchaseMax:
          r.purchaseRange.max === null ? null : money(r.purchaseRange.max),
        saleMin: r.saleRange.min === null ? null : money(r.saleRange.min),
        saleMax: r.saleRange.max === null ? null : money(r.saleRange.max),
        referenceMargin:
          cost === null || price === null ? null : money(price.sub(cost)),
        invoices: r.invoices.sort(
          (a, b) =>
            a.receivedAt.getTime() - b.receivedAt.getTime() ||
            a.receiptId.localeCompare(b.receiptId),
        ),
      };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "es") ||
        a.supplierName.localeCompare(b.supplierName, "es"),
    );
}
