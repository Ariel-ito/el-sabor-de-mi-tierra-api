import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db, lockRound } from "./core";
import { AssemblyDto, RecipeDto } from "./dto";
import { allocateStock, inventory, stockLock } from "./inventory";
import { decimal, money } from "./math";
import { assertQuantity, qtyText } from "./units";
const assemblyInclude = {
  items: { include: { product: true } },
  receipts: {
    include: {
      items: { include: { allocations: true, withdrawals: true } },
    },
  },
  round: true,
} as const;
// Combos: a recipe per combo product, and assemblies that turn component
// stock into combo stock. An assembly is stored as an ASSEMBLY purchase so the
// combos become an ordinary lot (cost, expiry, sales, encargos); the stock it
// used leaves as ASSEMBLY withdrawals, which are not losses.
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class AssembliesController {
  constructor(@Inject(Db) private db: Db) {}
  @Patch("products/:id/components") setRecipe(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RecipeDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const combo = await tx.product.findUnique({
        where: { id },
        include: { components: true, usedIn: true },
      });
      if (!combo) throw new NotFoundException("Producto no encontrado.");
      const ids = body.components.map((c) => c.componentId);
      if (new Set(ids).size !== ids.length)
        throw new BadRequestException("Producto repetido en la receta.");
      if (ids.includes(id))
        throw new BadRequestException("Un combo no puede llevarse a sí mismo.");
      if (body.components.length && combo.usedIn.length)
        throw new BadRequestException(
          "Este producto ya es parte de otro combo; no puede ser combo a su vez.",
        );
      const parts = await tx.product.findMany({
        where: { id: { in: ids } },
        include: { components: true },
      });
      for (const c of body.components) {
        const part = parts.find((p) => p.id === c.componentId);
        if (!part) throw new BadRequestException("Producto inexistente.");
        if (part.components.length)
          throw new BadRequestException(
            `${part.name} es un combo; un combo no puede llevar otro combo.`,
          );
        assertQuantity(part.unit, c.quantity, part.name);
      }
      await tx.productComponent.deleteMany({ where: { comboId: id } });
      if (body.components.length)
        await tx.productComponent.createMany({
          data: body.components.map((c) => ({
            comboId: id,
            componentId: c.componentId,
            quantity: c.quantity,
          })),
        });
      const after = await tx.productComponent.findMany({
        where: { comboId: id },
        include: { component: true },
      });
      await audit(
        tx,
        req.actor.id,
        "Product",
        id,
        "RECIPE",
        combo.components,
        after,
      );
      return after.map((c) => ({
        componentId: c.componentId,
        name: c.component.name,
        unit: c.component.unit,
        quantity: c.quantity.toString(),
      }));
    });
  }
  @Get("assemblies") async list(
    @Query("roundId", new ParseUUIDPipe({ optional: true })) roundId?: string,
  ) {
    const rows = await this.db.purchase.findMany({
      where: { kind: "ASSEMBLY", ...(roundId ? { roundId } : {}) },
      include: assemblyInclude,
      orderBy: { orderedAt: "desc" },
      take: roundId ? undefined : 50,
    });
    return rows.map((a) => {
      const lot = a.receipts[0]?.items[0];
      return {
        id: a.id,
        date: a.orderedAt,
        round: { id: a.round.id, name: a.round.name },
        product: {
          id: a.items[0].product.id,
          name: a.items[0].product.name,
          unit: a.items[0].product.unit,
        },
        quantity: a.items[0].quantity.toString(),
        cost: money(a.receipts[0]?.total ?? 0),
        unitCost: lot ? money(lot.effectiveUnitCost) : null,
        // Once any combo was reserved, delivered or withdrawn it can't be undone.
        undoable: !!lot && !lot.allocations.length && !lot.withdrawals.length,
      };
    });
  }
  @Post("assemblies") assemble(
    @Body() body: AssemblyDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        if (await tx.purchase.findUnique({ where: { id: body.id } }))
          return { id: body.id };
        const round = await lockRound(tx, body.roundId);
        const date = new Date(body.date);
        if (date > new Date())
          throw new BadRequestException("La fecha no puede ser futura.");
        const combo = await tx.product.findUnique({
          where: { id: body.comboId },
          include: { components: { include: { component: true } } },
        });
        if (!combo) throw new NotFoundException("Producto no encontrado.");
        if (!combo.components.length)
          throw new BadRequestException(
            "Este producto no tiene receta; defínela en Catálogos.",
          );
        assertQuantity(combo.unit, body.quantity, combo.name);
        await allocateStock(tx);
        // Oldest free stock received by then, whatever its cycle.
        const lots = (await inventory(tx)).filter(
          (l) => new Date(l.receivedAt) <= date,
        );
        const takes: { lotId: string; quantity: Prisma.Decimal }[] = [];
        let cost = decimal(0);
        let expiresAt: Date | null = null;
        for (const c of combo.components) {
          let need = decimal(c.quantity).mul(body.quantity);
          const total = need;
          for (const lot of lots) {
            if (need.lte(0)) break;
            if (lot.productId !== c.componentId) continue;
            const free = decimal(lot.available);
            if (free.lte(0)) continue;
            const take = Prisma.Decimal.min(need, free);
            takes.push({ lotId: lot.id, quantity: take });
            cost = cost.add(take.mul(lot.unitCost));
            if (lot.expiresAt && (!expiresAt || lot.expiresAt < expiresAt))
              expiresAt = new Date(lot.expiresAt);
            lot.available = free.sub(take).toString();
            need = need.sub(take);
          }
          if (need.gt(0))
            throw new BadRequestException(
              `Para ${qtyText(body.quantity, combo.unit)} de ${combo.name} hacen falta ${qtyText(total, c.component.unit)} de ${c.component.name}; solo hay ${qtyText(total.sub(need), c.component.unit)} libres.`,
            );
        }
        for (const t of takes)
          await tx.stockWithdrawal.create({
            data: {
              id: randomUUID(),
              receiptItemId: t.lotId,
              quantity: t.quantity,
              reason: "ASSEMBLY",
              assemblyId: body.id,
              notes: `Armado de ${combo.name}`,
            },
          });
        const unitCost = cost.div(body.quantity);
        const purchase = await tx.purchase.create({
          data: {
            id: body.id,
            kind: "ASSEMBLY",
            roundId: round.id,
            supplierId: combo.defaultSupplierId,
            orderedAt: date,
            items: {
              create: {
                productId: combo.id,
                quantity: body.quantity,
                quotedUnitCost: money(unitCost),
              },
            },
          },
          include: { items: true },
        });
        await tx.receipt.create({
          data: {
            id: randomUUID(),
            purchaseId: purchase.id,
            receivedAt: date,
            invoice: "Armado de combos",
            notes: body.notes || null,
            globalDiscount: 0,
            total: money(cost),
            items: {
              create: {
                purchaseItemId: purchase.items[0].id,
                quantity: body.quantity,
                unitCost: money(unitCost),
                unitDiscount: 0,
                allocatedDiscount: 0,
                netTotal: money(cost),
                effectiveUnitCost: unitCost.toDecimalPlaces(6),
                expiresAt,
              },
            },
          },
        });
        await allocateStock(tx);
        await audit(tx, req.actor.id, "Assembly", body.id, "CREATE", null, {
          combo: combo.id,
          quantity: body.quantity,
          takes,
          cost: money(cost),
        });
        return { id: body.id, cost: money(cost), unitCost: money(unitCost) };
      },
      { timeout: 15000 },
    );
  }
  // Take the combos apart: their stock returns to the components' lots.
  @Delete("assemblies/:id") undo(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const a = await tx.purchase.findUnique({
          where: { id },
          include: assemblyInclude,
        });
        if (!a || a.kind !== "ASSEMBLY")
          throw new NotFoundException("Armado no encontrado.");
        const lots = a.receipts.flatMap((r) => r.items);
        if (lots.some((l) => l.allocations.length || l.withdrawals.length))
          throw new ConflictException(
            "Algunos combos ya se reservaron, entregaron o dieron de baja; no se puede deshacer.",
          );
        await tx.stockWithdrawal.deleteMany({ where: { assemblyId: id } });
        await tx.receiptItem.deleteMany({
          where: { receiptId: { in: a.receipts.map((r) => r.id) } },
        });
        await tx.receipt.deleteMany({ where: { purchaseId: id } });
        await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
        await tx.purchase.delete({ where: { id } });
        await allocateStock(tx);
        await audit(tx, req.actor.id, "Assembly", id, "UNDO", a, {
          undone: true,
        });
        return { ok: true };
      },
      { timeout: 15000 },
    );
  }
}
