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
import { Prisma } from "@prisma/client";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import { OrderBatchDto } from "./dto";
import { assertQuantity } from "./units";
import { allocateStock, consumeReserved, stockLock } from "./inventory";
import {
  decimal,
  money,
  orderBalance,
  orderInclude,
  serializeOrder,
} from "./math";

@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class OrderBatchesController {
  constructor(@Inject(Db) private db: Db) {}

  @Post("orders/batch-operations") async apply(
    @Body() body: OrderBatchDto,
    @Req() req: AuthRequest,
  ) {
    if (new Set(body.orders.map((o) => o.id)).size !== body.orders.length)
      throw new BadRequestException("Hay encargos repetidos en la selección.");
    const date = new Date(body.date);
    if (date > new Date())
      throw new BadRequestException("La fecha no puede ser futura.");
    const pays = body.action === "PAY" || body.action === "COMPLETE";
    const delivers = body.action === "DELIVER" || body.action === "COMPLETE";
    const fingerprint = JSON.stringify({
      action: body.action,
      date: date.toISOString(),
      orders: body.orders
        .map((o) => ({
          id: o.id,
          version: o.version,
          ...(pays ? { method: o.method ?? body.method } : {}),
          ...((!delivers && body.action !== "PACK") || !o.items
            ? {}
            : {
                items: o.items
                  .map((i) => ({
                    orderItemId: i.orderItemId,
                    quantity: decimal(i.quantity).toString(),
                  }))
                  .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)),
              }),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        // The audit's unique primary key is the command ID. Check it before
        // versions or stock, so retries cannot charge or deliver anything twice.
        const prior = await tx.auditLog.findUnique({ where: { id: body.id } });
        if (prior) {
          if (
            prior.entityType !== "OrderBatch" ||
            prior.actorId !== req.actor.id ||
            (prior.after as Record<string, unknown>).request !== fingerprint
          )
            throw new ConflictException(
              "Este identificador corresponde a otro registro.",
            );
          return {
            id: body.id,
            replayed: true,
            orders: (
              await tx.order.findMany({
                where: { id: { in: body.orders.map((o) => o.id) } },
                include: orderInclude,
              })
            ).map(serializeOrder),
          };
        }
        const ids = body.orders.map((o) => o.id);
        if (body.action !== "PAY")
          await allocateStock(tx, {
            orderDates: new Map(ids.map((id) => [id, date])),
          });
        const orders = await tx.order.findMany({
          where: { id: { in: ids } },
          include: orderInclude,
          orderBy: { id: "asc" },
        });
        if (orders.length !== ids.length)
          throw new NotFoundException(
            "Uno de los encargos ya no existe. Actualiza la lista.",
          );
        for (const order of orders) {
          if (order.cancelledAt || !order.items.length)
            throw new ConflictException(
              `${order.customer.name}: el encargo está cancelado o vacío.`,
            );
          if (
            order.version !==
            body.orders.find((o) => o.id === order.id)!.version
          )
            throw new ConflictException(
              `${order.customer.name}: el encargo cambió. Actualiza la selección antes de registrar.`,
            );
          const input = body.orders.find((o) => o.id === order.id)!;
          if (body.action !== "PAY" && input.items) {
            if (
              input.items.length !== order.items.length ||
              new Set(input.items.map((i) => i.orderItemId)).size !==
                input.items.length ||
              input.items.some(
                (i) => !order.items.some((item) => item.id === i.orderItemId),
              )
            )
              throw new BadRequestException(
                "Revisa los productos incluidos en cada encargo.",
              );
            for (const item of order.items) {
              const planned = decimal(
                input.items.find((i) => i.orderItemId === item.id)!.quantity,
              );
              assertQuantity(item.product.unit, planned, item.product.name);
              const available = item.allocations.reduce(
                (s, a) => s.add(a.quantity).sub(a.delivered),
                decimal(0),
              );
              if (
                planned.gt(available) ||
                (body.action === "PACK" && planned.lt(item.packedQuantity))
              )
                throw new ConflictException(
                  `${order.customer.name}: la disponibilidad de ${item.product.name} cambió para esa fecha. Actualiza la revisión; no se guardó ningún encargo.`,
                );
            }
          }
        }
        for (const order of orders) {
          const input = body.orders.find((o) => o.id === order.id)!;
          const plannedQuantity = (item: (typeof order.items)[number]) => {
            const available = item.allocations.reduce(
              (s, a) => s.add(a.quantity).sub(a.delivered),
              decimal(0),
            );
            return input.items
              ? decimal(
                  input.items.find((i) => i.orderItemId === item.id)!.quantity,
                )
              : available;
          };
          let changed = false;
          if (body.action === "PACK") {
            const changes = [];
            for (const item of order.items) {
              const available = plannedQuantity(item);
              if (available.lte(item.packedQuantity)) continue;
              changes.push({
                orderItemId: item.id,
                product: item.product.name,
                supplier: item.supplier.name,
                unit: item.product.unit,
                before: item.packedQuantity.toString(),
                after: available.toString(),
              });
              await tx.orderItem.update({
                where: { id: item.id },
                data: { packedQuantity: available, packedAt: date },
              });
            }
            if (changes.length) {
              await audit(
                tx,
                req.actor.id,
                "Order",
                order.id,
                "PACKING",
                { version: order.version },
                { mode: "PACK", changes, batchId: body.id },
              );
              changed = true;
            }
          }
          if (delivers) {
            const items = order.items
              .map((i) => ({
                orderItemId: i.id,
                quantity: Prisma.Decimal.min(
                  plannedQuantity(i),
                  i.quantity.sub(
                    i.allocations.reduce(
                      (s, a) => s.add(a.delivered),
                      decimal(0),
                    ),
                  ),
                ),
              }))
              .filter((i) => i.quantity.gt(0));
            if (items.length) {
              for (const item of items)
                await consumeReserved(
                  tx,
                  item.orderItemId,
                  item.quantity,
                  date,
                );
              const delivery = await tx.delivery.create({
                data: {
                  id: randomUUID(),
                  orderId: order.id,
                  deliveredAt: date,
                  items: { create: items },
                },
                include: { items: true },
              });
              await audit(
                tx,
                req.actor.id,
                "Delivery",
                delivery.id,
                "CREATE",
                null,
                { ...delivery, batchId: body.id },
              );
              changed = true;
            }
          }
          if (pays) {
            const balance = orderBalance(order).balance;
            if (balance.gt(0)) {
              const payment = await tx.payment.create({
                data: {
                  id: randomUUID(),
                  orderId: order.id,
                  amount: money(balance),
                  receivedAmount: money(balance),
                  method: input.method ?? body.method,
                  paidAt: date,
                  notes:
                    body.action === "COMPLETE"
                      ? "Pago completo junto con la entrega"
                      : "Pago del saldo pendiente",
                },
              });
              await audit(
                tx,
                req.actor.id,
                "Payment",
                payment.id,
                "CREATE",
                null,
                { ...payment, batchId: body.id },
              );
              changed = true;
            }
          }
          if (changed)
            await tx.order.update({
              where: { id: order.id },
              data: { version: { increment: 1 } },
            });
        }
        await tx.auditLog.create({
          data: {
            id: body.id,
            actorId: req.actor.id,
            entityType: "OrderBatch",
            entityId: body.id,
            action: body.action,
            after: {
              request: fingerprint,
              orderIds: ids,
              date: date.toISOString(),
            },
          },
        });
        return {
          id: body.id,
          replayed: false,
          orders: (
            await tx.order.findMany({
              where: { id: { in: ids } },
              include: orderInclude,
            })
          ).map(serializeOrder),
        };
      },
      { timeout: 30000 },
    );
  }
}
