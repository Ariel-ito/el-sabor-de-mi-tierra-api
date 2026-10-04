import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import { SaleDto } from "./dto";
import {
  allocateStock,
  consumeReserved,
  inventory,
  stockLock,
} from "./inventory";
import { decimal, orderInclude, serializeOrder } from "./math";
export const WALK_IN = "Cliente de paso";
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class SalesController {
  constructor(@Inject(Db) private db: Db) {}
  // With roundId, every walk-in sale counted in that cycle; otherwise the latest.
  @Get("sales") async sales(
    @Query("roundId", new ParseUUIDPipe({ optional: true })) roundId?: string,
  ) {
    return (
      await this.db.order.findMany({
        where: { kind: "DIRECT", ...(roundId ? { roundId } : {}) },
        include: { ...orderInclude, round: true },
        orderBy: { createdAt: "desc" },
        ...(roundId ? {} : { take: 100 }),
      })
    ).map(serializeOrder);
  }
  // Walk-in sale from free stock: delivered on the spot, optionally paid, and
  // counted in the cycle of the first lot it consumes.
  @Post("sales") createSale(@Body() body: SaleDto, @Req() req: AuthRequest) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const prior = await tx.order.findUnique({
          where: { id: body.id },
          include: orderInclude,
        });
        if (prior) {
          if (prior.kind !== "DIRECT")
            throw new ConflictException("Identificador ya utilizado");
          return serializeOrder(prior);
        }
        const soldAt = new Date(body.soldAt);
        if (soldAt > new Date())
          throw new BadRequestException("La venta no puede ser futura.");
        if (
          new Set(body.items.map((i) => i.productId)).size !== body.items.length
        )
          throw new BadRequestException("Producto repetido.");
        const products = await tx.product.findMany({
          where: { id: { in: body.items.map((i) => i.productId) } },
        });
        await allocateStock(tx);
        const lots = (await inventory(tx)).filter(
          (l) => new Date(l.receivedAt) <= soldAt,
        );
        let home: string | undefined;
        const items: Prisma.OrderItemCreateWithoutOrderInput[] = [];
        for (const line of body.items) {
          const product = products.find((p) => p.id === line.productId);
          if (!product) throw new BadRequestException("Producto inexistente.");
          let need = decimal(line.quantity);
          const bySupplier = new Map<string, Prisma.Decimal>();
          for (const lot of lots) {
            if (need.lte(0)) break;
            if (lot.productId !== product.id || decimal(lot.available).lte(0))
              continue;
            const take = Prisma.Decimal.min(need, decimal(lot.available));
            home ??= lot.roundId;
            bySupplier.set(
              lot.supplierId,
              (bySupplier.get(lot.supplierId) ?? decimal(0)).add(take),
            );
            lot.available = decimal(lot.available).sub(take).toString();
            need = need.sub(take);
          }
          if (need.gt(0)) {
            const free = decimal(line.quantity).sub(need);
            throw new BadRequestException(
              `${product.name}: solo hay ${free} lb libres. Encárgalo para el próximo ciclo.`,
            );
          }
          for (const [supplierId, quantity] of bySupplier)
            items.push({
              product: { connect: { id: product.id } },
              supplier: { connect: { id: supplierId } },
              quantity,
              unitPrice: line.unitPrice,
              source: "STOCK",
              estimatedUnitCost: product.estimatedCost,
            });
        }
        const customerId =
          body.customerId ??
          (
            (await tx.customer.findFirst({ where: { name: WALK_IN } })) ??
            (await tx.customer.create({ data: { name: WALK_IN } }))
          ).id;
        const created = await tx.order.create({
          data: {
            id: body.id,
            kind: "DIRECT",
            roundId: home!,
            customerId,
            notes: body.notes,
            items: { create: items },
          },
          include: { items: true },
        });
        await allocateStock(tx);
        for (const item of created.items)
          await consumeReserved(tx, item.id, item.quantity, soldAt);
        await tx.delivery.create({
          data: {
            id: randomUUID(),
            orderId: created.id,
            deliveredAt: soldAt,
            items: {
              create: created.items.map((i) => ({
                orderItemId: i.id,
                quantity: i.quantity,
              })),
            },
          },
        });
        const view = serializeOrder(
          await tx.order.findUniqueOrThrow({
            where: { id: created.id },
            include: orderInclude,
          }),
        );
        if (body.payment && decimal(body.payment.amount).gt(0)) {
          if (decimal(body.payment.amount).gt(view.total))
            throw new BadRequestException(
              "El cobro no puede superar el total de la venta.",
            );
          await tx.payment.create({
            data: {
              id: randomUUID(),
              orderId: created.id,
              amount: body.payment.amount,
              method: body.payment.method,
              paidAt: soldAt,
            },
          });
        }
        const after = await tx.order.findUniqueOrThrow({
          where: { id: created.id },
          include: orderInclude,
        });
        await audit(
          tx,
          req.actor.id,
          "Sale",
          created.id,
          "CREATE",
          null,
          after,
        );
        return serializeOrder(after);
      },
      { timeout: 15000 },
    );
  }
}
