import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Inject,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { audit, AuthGuard, AuthRequest, Db, lockRound } from "./core";
import { DirectPurchaseDto } from "./dto";
import { allocateStock, stockLock } from "./inventory";
import { purchaseInclude, receive } from "./purchases";
import { assertQuantity } from "./units";
import {
  assertProductSupplier,
  resolvePurchaseSupplier,
} from "./purchase-supplier";

@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class DirectPurchasesController {
  constructor(@Inject(Db) private db: Db) {}
  @Post("purchases/direct") async buy(
    @Body() body: DirectPurchaseDto,
    @Req() req: AuthRequest,
  ) {
    if (!!body.supplierId === !!body.newSupplier)
      throw new BadRequestException(
        "Selecciona un proveedor o ingresa uno nuevo.",
      );
    const date = new Date(body.purchasedAt);
    if (date > new Date())
      throw new BadRequestException("La compra no puede tener fecha futura.");
    const fingerprint = JSON.stringify(body);
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const prior = await tx.auditLog.findUnique({ where: { id: body.id } });
        if (prior) {
          const result = prior.after as {
            request: string;
            productIds: string[];
          };
          if (
            prior.entityType !== "DirectPurchase" ||
            prior.actorId !== req.actor.id ||
            result.request !== fingerprint
          )
            throw new ConflictException(
              "Este identificador ya corresponde a otra compra.",
            );
          return {
            purchase: await tx.purchase.findUniqueOrThrow({
              where: { id: body.id },
              include: purchaseInclude,
            }),
            createdProducts: await tx.product.findMany({
              where: { id: { in: result.productIds } },
              include: { category: true, defaultSupplier: true },
            }),
            replayed: true,
          };
        }
        await lockRound(tx, body.roundId);
        const supplier = await resolvePurchaseSupplier(tx, body, req.actor.id);
        const productIds: string[] = [];
        const lines: {
          productId: string;
          quantity: string;
          quotedUnitCost: string;
        }[] = [];
        for (const line of body.items) {
          if (!!line.productId === !!line.newProduct)
            throw new BadRequestException(
              "Cada línea debe tener un producto del catálogo o uno nuevo.",
            );
          let productId = line.productId;
          if (line.newProduct) {
            const p = line.newProduct;
            const name = p.name.trim();
            if (
              await tx.product.findFirst({
                where: {
                  defaultSupplierId: supplier.id,
                  name: { equals: name, mode: "insensitive" },
                },
              })
            )
              throw new ConflictException(
                `${name} ya existe para ese proveedor. Elígelo del catálogo.`,
              );
            if (p.categoryId && p.categoryName)
              throw new BadRequestException(
                "Selecciona una categoría o escribe una nueva.",
              );
            let categoryId = p.categoryId;
            if (p.categoryName) {
              const categoryName = p.categoryName.trim();
              const found = await tx.productCategory.findFirst({
                where: { name: { equals: categoryName, mode: "insensitive" } },
              });
              if (found) categoryId = found.id;
              else {
                const category = await tx.productCategory.create({
                  data: { name: categoryName },
                });
                categoryId = category.id;
                await audit(
                  tx,
                  req.actor.id,
                  "ProductCategory",
                  category.id,
                  "CREATE",
                  null,
                  category,
                );
              }
            } else if (
              categoryId &&
              !(await tx.productCategory.findUnique({
                where: { id: categoryId },
              }))
            )
              throw new BadRequestException(
                "La categoría seleccionada ya no existe.",
              );
            const created = await tx.product.create({
              data: {
                name,
                description: p.description?.trim() || null,
                unit: p.unit,
                salePrice: p.salePrice,
                estimatedCost: line.unitCost,
                defaultSupplierId: supplier.id,
                categoryId,
                shelfLifeDays: p.shelfLifeDays,
                warnDays: p.warnDays,
              },
            });
            productId = created.id;
            productIds.push(created.id);
            await audit(
              tx,
              req.actor.id,
              "Product",
              created.id,
              "CREATE",
              null,
              created,
            );
          }
          const product = await tx.product.findUnique({
            where: { id: productId! },
            include: { components: true },
          });
          if (!product) throw new NotFoundException("Producto no encontrado.");
          assertProductSupplier(product, supplier.id);
          if (!product.active || product.components.length)
            throw new BadRequestException(
              `${product.name}: usa un producto activo que no sea un combo armado.`,
            );
          assertQuantity(product.unit, line.quantity, product.name);
          lines.push({
            productId: product.id,
            quantity: line.quantity,
            quotedUnitCost: line.unitCost,
          });
        }
        if (new Set(lines.map((l) => l.productId)).size !== lines.length)
          throw new BadRequestException(
            "Un producto está repetido en la compra. Combina sus cantidades.",
          );
        const purchase = await tx.purchase.create({
          data: {
            id: body.id,
            roundId: body.roundId,
            supplierId: supplier.id,
            orderedAt: date,
            items: { create: lines },
          },
          include: purchaseInclude,
        });
        await audit(
          tx,
          req.actor.id,
          "Purchase",
          purchase.id,
          "CREATE",
          null,
          purchase,
        );
        const received = await receive(
          tx,
          purchase.id,
          {
            id: randomUUID(),
            version: purchase.version,
            receivedAt: date.toISOString(),
            invoice: body.invoice?.trim() || "Compra directa",
            notes: body.notes,
            globalDiscount: body.globalDiscount,
            items: body.items.map((line, i) => ({
              purchaseItemId: purchase.items.find(
                (item) => item.productId === lines[i].productId,
              )!.id,
              quantity: line.quantity,
              unitCost: line.unitCost,
              unitDiscount: line.unitDiscount,
              ...(line.expiresAt ? { expiresAt: line.expiresAt } : {}),
            })),
          },
          req.actor.id,
        );
        await allocateStock(tx);
        await tx.auditLog.create({
          data: {
            id: body.id,
            actorId: req.actor.id,
            entityType: "DirectPurchase",
            entityId: purchase.id,
            action: "CREATE",
            after: { request: fingerprint, productIds },
          },
        });
        return {
          purchase: received,
          createdProducts: await tx.product.findMany({
            where: { id: { in: productIds } },
            include: { category: true, defaultSupplier: true },
          }),
          replayed: false,
        };
      },
      { timeout: 30000 },
    );
  }
}
