import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { audit } from "./core";
import { SupplierDto } from "./dto";

export async function resolvePurchaseSupplier(
  tx: Prisma.TransactionClient,
  choice: { supplierId?: string; newSupplier?: SupplierDto },
  actorId: string,
) {
  if (!!choice.supplierId === !!choice.newSupplier)
    throw new BadRequestException(
      "Selecciona un proveedor o ingresa uno nuevo.",
    );
  let supplierId = choice.supplierId;
  if (choice.newSupplier) {
    const { withProducts: _, ...data } = choice.newSupplier;
    const name = data.name.trim(),
      region = data.region.trim();
    if (!name || !region)
      throw new BadRequestException("Completa nombre y región del proveedor.");
    if (
      await tx.supplier.findFirst({
        where: {
          name: { equals: name, mode: "insensitive" },
          region: { equals: region, mode: "insensitive" },
        },
      })
    )
      throw new ConflictException(
        "Ese proveedor ya existe. Selecciónalo de la lista.",
      );
    const supplier = await tx.supplier.create({
      data: { ...data, name, region },
    });
    supplierId = supplier.id;
    await audit(tx, actorId, "Supplier", supplier.id, "CREATE", null, supplier);
  }
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId! } });
  if (!supplier || !supplier.active)
    throw new BadRequestException("Selecciona un proveedor activo.");
  return supplier;
}

export function directProductIds(value: Prisma.JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const ids = value.productIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}
