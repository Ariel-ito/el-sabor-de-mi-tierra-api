import { assertQuantity } from "./units";
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
  ParseIntPipe,
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
import {
  CarryDto,
  DeliveryDto,
  OrderCancelDto,
  OrderDto,
  OrderPatchDto,
  PaymentDto,
  VoidPaymentDto,
} from "./dto";
import {
  allocateStock,
  consumeReserved,
  releaseForEdit,
  stockLock,
} from "./inventory";
import {
  decimal,
  orderBalance,
  orderInclude,
  serializeOrder,
  shipping,
} from "./math";
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(@Inject(Db) private db: Db) {}
  @Get("orders") async orders(
    @Query("roundId", new ParseUUIDPipe({ optional: true })) roundId?: string,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        await allocateStock(tx);
        return (
          await tx.order.findMany({
            where: {
              kind: "ENCARGO",
              cancelledAt: null,
              ...(roundId ? { roundId } : {}),
            },
            include: orderInclude,
            orderBy: { createdAt: "desc" },
          })
        ).map(serializeOrder);
      },
      { timeout: 15000 },
    );
  }
  @Get("orders/cancelled") async cancelled(
    @Query("roundId", new ParseUUIDPipe({ optional: true })) roundId?: string,
  ) {
    return (
      await this.db.order.findMany({
        where: {
          kind: "ENCARGO",
          cancelledAt: { not: null },
          ...(roundId ? { roundId } : {}),
        },
        include: orderInclude,
        orderBy: { cancelledAt: "desc" },
      })
    ).map(serializeOrder);
  }
  // The customer no longer wants it: the encargo stays on record as
  // cancelled, its lines go away and the stock they held is free to sell.
  @Post("orders/:id/cancel") cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: OrderCancelDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const before = await tx.order.findUnique({
          where: { id },
          include: orderInclude,
        });
        if (!before || before.kind !== "ENCARGO")
          throw new NotFoundException("Encargo no encontrado.");
        if (before.cancelledAt) return serializeOrder(before);
        if (before.version !== body.version)
          throw new ConflictException("El encargo cambió; actualiza antes.");
        if (before.deliveries.length)
          throw new ConflictException(
            "Este encargo ya tiene entregas; edítalo para quitar lo que no se va a entregar.",
          );
        const view = serializeOrder(before);
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.order.update({
          where: { id },
          data: {
            cancelledAt: new Date(),
            cancelReason: body.reason.trim(),
            cancelledItems: {
              items: view.items.map((i: any) => ({
                productId: i.productId,
                name: i.product.name,
                unit: i.product.unit,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                lineTotal: i.lineTotal,
              })),
              delivery: view.delivery,
              shippingFee: view.shippingFee,
              total: view.total,
            },
            delivery: "PICKUP",
            shippingFee: 0,
            version: { increment: 1 },
          },
        });
        await allocateStock(tx);
        if (body.toAccount) {
          const { credit } = orderBalance(
            await tx.order.findUniqueOrThrow({
              where: { id },
              include: orderInclude,
            }),
          );
          if (credit.gt(0))
            await tx.customerCredit.create({
              data: {
                id: randomUUID(),
                customerId: before.customerId,
                kind: "OVERPAY",
                amount: credit,
                date: new Date(),
                orderId: id,
                notes: "Pago de un encargo cancelado",
              },
            });
        }
        const after = serializeOrder(
          await tx.order.findUniqueOrThrow({
            where: { id },
            include: orderInclude,
          }),
        );
        await audit(tx, req.actor.id, "Order", id, "CANCEL", view, after);
        return after;
      },
      { timeout: 15000 },
    );
  }
  // An encargo saved by mistake: removed entirely while nothing was
  // delivered or paid.
  @Delete("orders/:id") remove(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("version", ParseIntPipe) version: number,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const before = await tx.order.findUnique({
          where: { id },
          include: orderInclude,
        });
        if (!before || before.kind !== "ENCARGO")
          throw new NotFoundException("Encargo no encontrado.");
        if (before.version !== version)
          throw new ConflictException("El encargo cambió; actualiza antes.");
        if (before.deliveries.length)
          throw new ConflictException(
            "Este encargo ya tiene entregas; no se puede eliminar.",
          );
        if (before.payments.some((p) => !p.voidedAt))
          throw new ConflictException(
            "Este encargo tiene abonos. Anúlalos primero, o cancélalo para dejar el pago como saldo a favor.",
          );
        if (await tx.customerCredit.count({ where: { orderId: id } }))
          throw new ConflictException(
            "Este encargo movió saldo de la cuenta del cliente; anula esos movimientos primero.",
          );
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.payment.deleteMany({ where: { orderId: id } });
        await tx.order.delete({ where: { id } });
        await allocateStock(tx);
        await audit(tx, req.actor.id, "Order", id, "DELETE", before, {
          deleted: true,
        });
        return { ok: true };
      },
      { timeout: 15000 },
    );
  }

  // Encargos of earlier cycles with pounds to be supplied from this one.
  @Get("orders/carried") async carried(
    @Query("roundId", ParseUUIDPipe) roundId: string,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        await allocateStock(tx);
        return (
          await tx.order.findMany({
            where: {
              kind: "ENCARGO",
              roundId: { not: roundId },
              items: { some: { fulfillRoundId: roundId } },
            },
            include: { ...orderInclude, round: true },
            orderBy: { createdAt: "asc" },
          })
        ).map(serializeOrder);
      },
      { timeout: 15000 },
    );
  }
  // Supply a line's pending pounds from another open cycle. The sale and its
  // payments stay in the encargo's own cycle.
  @Post("orders/:id/items/:itemId/carry") carry(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Body() body: CarryDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const before = await tx.order.findUnique({
          where: { id },
          include: orderInclude,
        });
        if (!before || before.kind !== "ENCARGO")
          throw new NotFoundException("Encargo no encontrado.");
        if (before.version !== body.version)
          throw new ConflictException("El encargo cambió; actualiza antes.");
        const item = before.items.find((i) => i.id === itemId);
        if (!item) throw new BadRequestException("Producto ajeno al encargo.");
        if (item.source === "STOCK")
          throw new BadRequestException(
            "Las líneas de inventario ya pueden tomar producto de cualquier ciclo.",
          );
        const delivered = item.allocations.reduce(
          (s, a) => s.add(a.delivered),
          decimal(0),
        );
        if (body.roundId) {
          if (delivered.gte(item.quantity))
            throw new BadRequestException("Esta línea ya está entregada.");
          if (body.roundId === before.roundId)
            throw new BadRequestException(
              "Elige un ciclo distinto al del encargo.",
            );
          const target = await lockRound(tx, body.roundId);
          if (target.status !== "OPEN")
            throw new BadRequestException(
              "El ciclo destino debe estar abierto.",
            );
        } else {
          const own = await lockRound(tx, before.roundId);
          if (own.status !== "OPEN" && delivered.lt(item.quantity))
            throw new BadRequestException(
              "El ciclo del encargo está cerrado; la línea debe entregarse en otro ciclo.",
            );
        }
        // Re-reserve from scratch so stock of the previous destination is freed.
        await releaseForEdit(tx, item.id, item.quantity.toString());
        await tx.orderItem.update({
          where: { id: item.id },
          data: { fulfillRoundId: body.roundId ?? null },
        });
        await tx.order.update({
          where: { id },
          data: { version: { increment: 1 } },
        });
        await allocateStock(tx);
        const after = await tx.order.findUniqueOrThrow({
          where: { id },
          include: orderInclude,
        });
        await audit(tx, req.actor.id, "Order", id, "CARRY", before, after);
        return serializeOrder(after);
      },
      { timeout: 15000 },
    );
  }
  @Post("orders") createOrder(@Body() body: OrderDto, @Req() req: AuthRequest) {
    return this.db.$transaction(async (tx) => {
      await stockLock(tx);
      const round = await lockRound(tx, body.roundId);
      if (round.status !== "OPEN")
        throw new ConflictException("El ciclo está cerrado");
      if (body.items.some((i) => i.id))
        throw new BadRequestException(
          "Un pedido nuevo no admite IDs de líneas existentes",
        );
      const items = await this.costItems(tx, body.items);
      const after = await tx.order.create({
        data: {
          roundId: body.roundId,
          customerId: body.customerId,
          notes: body.notes,
          ...shipping(body),
          items: { create: items },
        },
        include: orderInclude,
      });
      await audit(tx, req.actor.id, "Order", after.id, "CREATE", null, after);
      await allocateStock(tx);
      return serializeOrder(
        await tx.order.findUniqueOrThrow({
          where: { id: after.id },
          include: orderInclude,
        }),
      );
    });
  }
  private async costItems(
    tx: Prisma.TransactionClient,
    items: {
      id?: string;
      productId: string;
      supplierId: string;
      quantity: string;
      unitPrice: string;
      totalAmount?: string;
      source?: "PREORDER" | "STOCK";
    }[],
    previous: any[] = [],
  ) {
    const ids = [...new Set(items.map((i) => i.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: ids }, active: true },
    });
    if (products.length !== ids.length)
      throw new BadRequestException("Producto inexistente o inactivo");
    for (const i of items) {
      const p = products.find((x) => x.id === i.productId)!;
      assertQuantity(p.unit, i.quantity, p.name);
    }
    const used = new Set<string>();
    return items.map(({ id, ...item }) => {
      const old = id
        ? previous.find((p) => p.id === id)
        : previous.find(
            (p) =>
              !used.has(p.id) &&
              p.productId === item.productId &&
              p.supplierId === item.supplierId,
          );
      if (id && (!old || used.has(id)))
        throw new BadRequestException("Línea de pedido inválida o duplicada");
      if (old) used.add(old.id);
      const preserve =
        old &&
        old.productId === item.productId &&
        old.supplierId === item.supplierId;
      return {
        ...item,
        id: old?.id,
        source: item.source ?? old?.source ?? "PREORDER",
        totalAmount: item.totalAmount ?? null,
        unitPrice:
          item.totalAmount !== undefined
            ? new Prisma.Decimal(item.totalAmount)
                .div(item.quantity)
                .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
            : item.unitPrice,
        estimatedUnitCost: preserve
          ? old.estimatedUnitCost
          : products.find((p) => p.id === item.productId)!.estimatedCost,
      };
    });
  }
  @Patch("orders/:id") patchOrder(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: OrderPatchDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await stockLock(tx);
      const current = await tx.order.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("Pedido no encontrado");
      if (current.kind === "DIRECT")
        throw new BadRequestException(
          "Las ventas sin encargo no se editan; registra una venta nueva.",
        );
      if (current.cancelledAt)
        throw new ConflictException("Este encargo está cancelado.");
      const round = await lockRound(tx, current.roundId);
      if (round.status !== "OPEN")
        throw new ConflictException("El ciclo está cerrado");
      const before = await tx.order.findUniqueOrThrow({
        where: { id },
        include: orderInclude,
      });
      if (before.version !== body.version)
        throw new ConflictException(
          "El pedido cambió; recarga antes de editar",
        );
      const items = body.items
        ? await this.costItems(tx, body.items, before.items)
        : undefined;
      const changed = await tx.order.updateMany({
        where: { id, version: body.version },
        data: {
          customerId: body.customerId,
          notes: body.notes,
          ...(body.delivery || body.shippingFee !== undefined
            ? shipping({
                delivery: body.delivery ?? before.delivery,
                shippingFee:
                  body.shippingFee ??
                  ((body.delivery ?? before.delivery) === "PICKUP"
                    ? "0"
                    : before.shippingFee.toString()),
              })
            : {}),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException(
          "El pedido cambió; recarga antes de editar",
        );
      if (items) {
        for (const old of before.items) {
          const next = items.find((i) => i.id === old.id);
          const same =
            next &&
            next.productId === old.productId &&
            next.supplierId === old.supplierId;
          if (!same && old.allocations.some((a) => a.delivered.gt(0)))
            throw new BadRequestException(
              "No puedes quitar o sustituir un producto entregado.",
            );
          if (!next || !same || !old.quantity.eq(next.quantity))
            await releaseForEdit(tx, old.id, same ? next!.quantity : "0");
          if (!next) await tx.orderItem.delete({ where: { id: old.id } });
        }
        for (const item of items) {
          if (item.id)
            await tx.orderItem.update({ where: { id: item.id }, data: item });
          else await tx.orderItem.create({ data: { ...item, orderId: id } });
        }
      }
      await allocateStock(tx);
      const after = await tx.order.findUniqueOrThrow({
        where: { id },
        include: orderInclude,
      });
      await audit(tx, req.actor.id, "Order", id, "UPDATE", before, after);
      return serializeOrder(after);
    });
  }
  @Post("orders/:id/payments") async pay(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: PaymentDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await stockLock(tx);
      const order = await tx.order.findUniqueOrThrow({
        where: { id },
        include: orderInclude,
      });
      if (order.cancelledAt)
        throw new ConflictException("Este encargo está cancelado.");
      const prior = await tx.payment.findUnique({ where: { id: body.id } });
      if (prior) {
        if (prior.orderId !== id)
          throw new ConflictException("Identificador ya utilizado");
        return serializeOrder(order);
      }
      if (order.version !== body.version)
        throw new ConflictException(
          "El encargo cambió. Actualiza antes de registrar el pago.",
        );
      const view = serializeOrder(order);
      const excess = decimal(body.amount).sub(view.balance);
      if (
        decimal(body.amount).lte(0) ||
        decimal(view.balance).lte(0) ||
        (excess.gt(0) && !body.excessToAccount)
      )
        throw new BadRequestException(
          "El abono debe ser mayor a cero y no superar el saldo pendiente.",
        );
      if (new Date(body.paidAt) > new Date())
        throw new BadRequestException("La fecha de pago no puede ser futura.");
      const { version, excessToAccount, ...data } = body;
      const payment = await tx.payment.create({
        data: {
          ...data,
          amount: excess.gt(0) ? view.balance : data.amount,
          orderId: id,
        },
      });
      if (excess.gt(0))
        await tx.customerCredit.create({
          data: {
            id: randomUUID(),
            customerId: order.customerId,
            kind: "DEPOSIT",
            amount: excess,
            method: body.method,
            date: new Date(body.paidAt),
            notes: "Excedente de un abono",
            orderId: id,
          },
        });
      await tx.order.update({
        where: { id },
        data: { version: { increment: 1 } },
      });
      await audit(
        tx,
        req.actor.id,
        "Payment",
        payment.id,
        "CREATE",
        null,
        payment,
      );
      return serializeOrder(
        await tx.order.findUniqueOrThrow({
          where: { id },
          include: orderInclude,
        }),
      );
    });
  }
  @Post("orders/:id/payments/:paymentId/void") async voidPayment(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("paymentId", ParseUUIDPipe) paymentId: string,
    @Body() body: VoidPaymentDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await stockLock(tx);
      const before = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      if (before.orderId !== id)
        throw new BadRequestException("El pago no pertenece a este encargo.");
      if (
        !before.voidedAt &&
        (await tx.customerCredit.count({
          where: { orderId: id, kind: "OVERPAY", voidedAt: null },
        }))
      )
        throw new BadRequestException(
          "Parte de lo pagado se pasó a la cuenta del cliente; anula eso primero.",
        );
      if (!before.voidedAt) {
        // A payment made with account credit gives that credit back.
        await tx.customerCredit.updateMany({
          where: { paymentId, voidedAt: null },
          data: { voidedAt: new Date(), voidReason: body.reason },
        });
        const after = await tx.payment.update({
          where: { id: paymentId },
          data: { voidedAt: new Date(), voidReason: body.reason },
        });
        await tx.order.update({
          where: { id },
          data: { version: { increment: 1 } },
        });
        await audit(
          tx,
          req.actor.id,
          "Payment",
          paymentId,
          "VOID",
          before,
          after,
        );
      }
      return serializeOrder(
        await tx.order.findUniqueOrThrow({
          where: { id },
          include: orderInclude,
        }),
      );
    });
  }
  @Post("orders/:id/deliveries") async deliver(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: DeliveryDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const prior = await tx.delivery.findUnique({ where: { id: body.id } });
        if (prior) {
          if (prior.orderId !== id)
            throw new ConflictException("Identificador ya utilizado");
          return serializeOrder(
            await tx.order.findUniqueOrThrow({
              where: { id },
              include: orderInclude,
            }),
          );
        }
        await allocateStock(tx);
        const order = await tx.order.findUniqueOrThrow({
          where: { id },
          include: orderInclude,
        });
        if (order.version !== body.version)
          throw new ConflictException(
            "El encargo cambió. Actualiza antes de entregar.",
          );
        if (new Date(body.deliveredAt) > new Date())
          throw new BadRequestException("La entrega no puede ser futura.");
        if (
          new Set(body.items.map((i) => i.orderItemId)).size !==
          body.items.length
        )
          throw new BadRequestException("Producto repetido.");
        for (const input of body.items) {
          const item = order.items.find((i) => i.id === input.orderItemId);
          if (!item)
            throw new BadRequestException("Producto ajeno al encargo.");
          assertQuantity(item.product.unit, input.quantity, item.product.name);
          await consumeReserved(
            tx,
            item.id,
            input.quantity,
            new Date(body.deliveredAt),
          );
        }
        const delivery = await tx.delivery.create({
          data: {
            id: body.id,
            orderId: id,
            deliveredAt: body.deliveredAt,
            items: { create: body.items },
          },
          include: { items: true },
        });
        await tx.order.update({
          where: { id },
          data: { version: { increment: 1 } },
        });
        await audit(
          tx,
          req.actor.id,
          "Delivery",
          delivery.id,
          "CREATE",
          null,
          delivery,
        );
        return serializeOrder(
          await tx.order.findUniqueOrThrow({
            where: { id },
            include: orderInclude,
          }),
        );
      },
      { timeout: 15000 },
    );
  }
}
