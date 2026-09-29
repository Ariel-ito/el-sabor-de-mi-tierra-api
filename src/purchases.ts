import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { decimal, money, lineTotal } from "./math";
import { ReceiptDto } from "./dto";
export const purchaseInclude = {
  supplier: true,
  round: true,
  items: { include: { product: true } },
  receipts: {
    include: { items: true },
    orderBy: { receivedAt: "asc" as const },
  },
} as const;
// Allocate whole cents by largest remainder so the invoice always reconciles.
export function allocateDiscount(amounts: string[], discount: string) {
  const cents = amounts.map((x) => decimal(x).mul(100));
  const total = cents.reduce((a, b) => a.add(b), decimal(0));
  const d = decimal(discount).mul(100);
  if (d.gt(total))
    throw new BadRequestException(
      "El descuento global supera el importe de la factura",
    );
  if (total.isZero()) return cents.map(() => "0.00");
  const raw = cents.map((x) => x.mul(d).div(total));
  const allocated = raw.map((x) => x.floor());
  let remaining = d
    .sub(allocated.reduce((a, b) => a.add(b), decimal(0)))
    .toNumber();
  const order = raw
    .map((v, i) => ({ i, f: v.sub(allocated[i]) }))
    .sort((a, b) => b.f.comparedTo(a.f) || a.i - b.i);
  for (const { i } of order) {
    if (!remaining) break;
    allocated[i] = allocated[i].add(1);
    remaining--;
  }
  return allocated.map((x) => money(x.div(100)));
}
export async function receive(
  tx: Prisma.TransactionClient,
  purchaseId: string,
  body: ReceiptDto,
  actorId: string,
) {
  await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id=${purchaseId}::uuid FOR UPDATE`;
  const purchase = await tx.purchase.findUniqueOrThrow({
    where: { id: purchaseId },
    include: purchaseInclude,
  });
  const existing = await tx.receipt.findUnique({ where: { id: body.id } });
  if (existing) {
    if (existing.purchaseId !== purchaseId)
      throw new ConflictException("Identificador de recepción ya utilizado");
    return purchase;
  }
  if (purchase.version !== body.version)
    throw new ConflictException(
      "La compra cambió; actualiza antes de registrar la recepción",
    );
  const receivedAt = new Date(body.receivedAt);
  if (receivedAt < purchase.orderedAt || receivedAt > new Date())
    throw new BadRequestException(
      "La recepción debe estar entre la fecha del pedido y ahora",
    );
  if (
    new Set(body.items.map((i) => i.purchaseItemId)).size !== body.items.length
  )
    throw new BadRequestException("Producto repetido en recepción");
  const amounts = body.items.map((i) => {
    const line = purchase.items.find((p) => p.id === i.purchaseItemId);
    if (!line)
      throw new BadRequestException("Producto no pertenece a esta compra");
    const prior = purchase.receipts
      .flatMap((r) => r.items)
      .filter((r) => r.purchaseItemId === line.id)
      .reduce((a, r) => a.add(r.quantity), decimal(0));
    if (prior.add(i.quantity).gt(line.quantity))
      throw new BadRequestException("La cantidad recibida supera lo pendiente");
    if (decimal(i.unitDiscount).gt(i.unitCost))
      throw new BadRequestException("Descuento por libra mayor que el precio");
    return lineTotal(i.quantity, decimal(i.unitCost).sub(i.unitDiscount));
  });
  const allocated = allocateDiscount(amounts, body.globalDiscount);
  const lines = body.items.map((i, n) => {
    const netTotal = decimal(amounts[n]).sub(allocated[n]);
    return {
      ...i,
      allocatedDiscount: allocated[n],
      netTotal: money(netTotal),
      effectiveUnitCost: netTotal.div(i.quantity).toDecimalPlaces(6),
    };
  });
  // Product locks are ordered to serialize receipts from concurrent purchases.
  const productIds = body.items
    .map(
      (i) => purchase.items.find((p) => p.id === i.purchaseItemId)!.productId,
    )
    .sort();
  for (const id of productIds)
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id=${id}::uuid FOR UPDATE`;
  const after = await tx.receipt.create({
    data: {
      id: body.id,
      purchaseId,
      receivedAt,
      invoice: body.invoice,
      notes: body.notes,
      globalDiscount: body.globalDiscount,
      total: money(lines.reduce((a, i) => a.add(i.netTotal), decimal(0))),
      items: { create: lines },
    },
    include: { items: true },
  });
  for (const line of after.items) {
    const productId = purchase.items.find(
      (i) => i.id === line.purchaseItemId,
    )!.productId;
    const product = await tx.product.findUniqueOrThrow({
      where: { id: productId },
    });
    // Alternative suppliers have their own history, never overwrite the habitual supplier's cost.
    if (
      product.defaultSupplierId === purchase.supplierId &&
      (!product.costEffectiveAt || receivedAt >= product.costEffectiveAt)
    ) {
      await tx.product.update({
        where: { id: productId },
        data: {
          estimatedCost: money(line.effectiveUnitCost),
          costEffectiveAt: receivedAt,
        },
      });
    }
  }
  await tx.purchase.update({
    where: { id: purchaseId },
    data: { version: { increment: 1 } },
  });
  await tx.auditLog.create({
    data: {
      actorId,
      entityType: "Receipt",
      entityId: after.id,
      action: "CREATE",
      after: JSON.parse(JSON.stringify(after)),
    },
  });
  return tx.purchase.findUniqueOrThrow({
    where: { id: purchaseId },
    include: purchaseInclude,
  });
}
