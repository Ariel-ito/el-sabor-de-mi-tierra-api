import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
// How each product is counted. Only pounds take halves; the rest are whole.
export const UNITS: Record<string, { one: string; many: string }> = {
  lb: { one: "lb", many: "lb" },
  unidad: { one: "unidad", many: "unidades" },
  bolsa: { one: "bolsa", many: "bolsas" },
  bote: { one: "bote", many: "botes" },
  frasco: { one: "frasco", many: "frascos" },
  botella: { one: "botella", many: "botellas" },
  paquete: { one: "paquete", many: "paquetes" },
  docena: { one: "docena", many: "docenas" },
  carton: { one: "cartón", many: "cartones" },
};
export const UNIT_KEYS = Object.keys(UNITS);
// Relabel one counted piece/package without converting quantity or price.
// Weight and dozens have different scales and need a separate product.
const PIECE_UNITS = new Set([
  "unidad",
  "bolsa",
  "bote",
  "frasco",
  "botella",
  "paquete",
  "carton",
]);
export const isUnitLabelCorrection = (from: string, to: string) =>
  PIECE_UNITS.has(from) && PIECE_UNITS.has(to);
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
  // A catalog correction must not race a purchase validated in the old unit.
  for (const id of [...new Set(lines.map((l) => l.productId))].sort())
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id=${id}::uuid FOR UPDATE`;
  const products = await tx.product.findMany({
    where: { id: { in: lines.map((l) => l.productId) } },
  });
  for (const l of lines) {
    const p = products.find((x) => x.id === l.productId);
    if (p) assertQuantity(p.unit, l.quantity, p.name);
  }
}
