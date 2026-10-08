import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
// How each product is counted. Only pounds take halves; the rest are whole.
export const UNITS: Record<string, { one: string; many: string }> = {
  lb: { one: "lb", many: "lb" },
  unidad: { one: "unidad", many: "unidades" },
  bolsa: { one: "bolsa", many: "bolsas" },
  bote: { one: "bote", many: "botes" },
  botella: { one: "botella", many: "botellas" },
  paquete: { one: "paquete", many: "paquetes" },
  docena: { one: "docena", many: "docenas" },
  carton: { one: "cartón", many: "cartones" },
};
export const UNIT_KEYS = Object.keys(UNITS);
export const qtyText = (quantity: Prisma.Decimal.Value, unit = "lb") => {
  const q = new Prisma.Decimal(quantity);
  const u = UNITS[unit] ?? UNITS.lb;
  return `${q.toString()} ${q.eq(1) ? u.one : u.many}`;
};
export function assertQuantity(
  unit: string,
  quantity: Prisma.Decimal.Value,
  name: string,
) {
  if (unit !== "lb" && !new Prisma.Decimal(quantity).isInteger())
    throw new BadRequestException(
      `${name} se cuenta por ${UNITS[unit]?.one ?? unit}: usa cantidades enteras.`,
    );
}
// Validate a set of lines against their products' units.
export async function checkQuantities(
  tx: Prisma.TransactionClient,
  lines: { productId: string; quantity: Prisma.Decimal.Value }[],
) {
  const products = await tx.product.findMany({
    where: { id: { in: lines.map((l) => l.productId) } },
  });
  for (const l of lines) {
    const p = products.find((x) => x.id === l.productId);
    if (p) assertQuantity(p.unit, l.quantity, p.name);
  }
}
