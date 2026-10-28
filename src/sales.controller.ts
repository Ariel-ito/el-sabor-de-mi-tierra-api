import { assertQuantity, qtyText } from "./units";
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
import { SaleDto, SaleLineDto, SalePatchDto } from "./dto";
import {
  allocateStock,
  consumeReserved,
  inventory,
  stockLock,
  expiredOn,
} from "./inventory";
import { decimal, orderInclude, serializeOrder, shipping } from "./math";
export const WALK_IN = "Cliente de paso";
const SET_ASIDE_NEEDS_CUSTOMER = "Elige el cliente para apartarle el producto.";
type Tx = Prisma.TransactionClient;
async function walkInCustomer(tx: Tx, customerId?: string) {
  return (
    customerId ??
    (
      (await tx.customer.findFirst({ where: { name: WALK_IN } })) ??
      (await tx.customer.create({ data: { name: WALK_IN } }))
    ).id
  );
}
// Turn requested lines into order items backed by free stock of one cycle,
// split by supplier because each lot belongs to one.
async function stockItems(
  tx: Tx,
  roundId: string,
  lines: SaleLineDto[],
  soldAt: Date,
) {
  if (new Set(lines.map((i) => i.productId)).size !== lines.length)
    throw new BadRequestException("Producto repetido.");
  const products = await tx.product.findMany({
    where: { id: { in: lines.map((i) => i.productId) } },
  });
  await allocateStock(tx);
  // Any cycle's free stock received by then, oldest first; the sale itself
  // counts in `roundId`.
  const lots = (await inventory(tx, soldAt)).filter(
    (l) => new Date(l.receivedAt) <= soldAt && !expiredOn(l.expiresAt, soldAt),
  );
  const items: Prisma.OrderItemCreateWithoutOrderInput[] = [];
  for (const line of lines) {
    const product = products.find((p) => p.id === line.productId);
    if (!product) throw new BadRequestException("Producto inexistente.");
    assertQuantity(product.unit, line.quantity, product.name);
    let need = decimal(line.quantity);
    const bySupplier = new Map<string, Prisma.Decimal>();
    for (const lot of lots) {
      if (need.lte(0)) break;
      if (lot.productId !== product.id || decimal(lot.available).lte(0))
        continue;
      const take = Prisma.Decimal.min(need, decimal(lot.available));
      bySupplier.set(
        lot.supplierId,
        (bySupplier.get(lot.supplierId) ?? decimal(0)).add(take),
      );
      lot.available = decimal(lot.available).sub(take).toString();
      need = need.sub(take);
    }
    if (need.gt(0))
      throw new BadRequestException(
        `${product.name}: solo hay ${qtyText(decimal(line.quantity).sub(need), product.unit)} libres en inventario.`,
      );
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
  return items;
}
// Walk-in sales leave with the customer: reserve and deliver every pound.
async function deliverAll(tx: Tx, orderId: string, soldAt: Date) {
  await allocateStock(tx, { orderId, at: soldAt, requireStock: true });
  const items = await tx.orderItem.findMany({ where: { orderId } });
  for (const item of items)
    await consumeReserved(tx, item.id, item.quantity, soldAt);
  await tx.delivery.create({
    data: {
      id: randomUUID(),
      orderId,
      deliveredAt: soldAt,
      items: {
        create: items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
      },
    },
  });
}
// Drop items and deliveries; their allocations cascade, returning the stock.
async function clearItems(tx: Tx, orderId: string) {
  await tx.deliveryItem.deleteMany({ where: { delivery: { orderId } } });
  await tx.delivery.deleteMany({ where: { orderId } });
  await tx.orderItem.deleteMany({ where: { orderId } });
}
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class SalesController {
  constructor(@Inject(Db) private db: Db) {}
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
  // Sale from a cycle's free stock, counted in that cycle: delivered on the
  // spot or set aside for later, optionally paid.
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
        if (body.deliverNow === false && !body.customerId)
          throw new BadRequestException(SET_ASIDE_NEEDS_CUSTOMER);
        let roundId = body.roundId;
        if (roundId) await lockRound(tx, roundId);
        else {
          await allocateStock(tx);
          roundId = (await inventory(tx)).find(
            (l) =>
              l.productId === body.items[0].productId &&
              !expiredOn(l.expiresAt, soldAt) &&
              new Date(l.receivedAt) <= soldAt &&
              decimal(l.available).gt(0),
          )?.roundId;
          if (!roundId)
            throw new BadRequestException(
              "No hay existencia libre de ese producto.",
            );
        }
        const items = await stockItems(tx, roundId, body.items, soldAt);
        const created = await tx.order.create({
          data: {
            id: body.id,
            kind: "DIRECT",
            createdAt: soldAt,
            roundId,
            customerId: await walkInCustomer(tx, body.customerId),
            notes: body.notes,
            ...shipping(body),
            items: { create: items },
          },
        });
        // Set aside: reserved for the customer, delivered and paid later.
        if (body.deliverNow === false)
          await allocateStock(tx, {
            orderId: created.id,
            at: soldAt,
            requireStock: true,
          });
        else await deliverAll(tx, created.id, soldAt);
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
  private async editable(tx: Tx, id: string, version: number) {
    const sale = await tx.order.findUnique({
      where: { id },
      include: orderInclude,
    });
    if (!sale || sale.kind !== "DIRECT")
      throw new NotFoundException("Venta no encontrada.");
    const round = await lockRound(tx, sale.roundId);
    if (round.status !== "OPEN")
      throw new ConflictException(
        "El ciclo de esta venta está cerrado; ya no se puede modificar.",
      );
    if (sale.version !== version)
      throw new ConflictException("La venta cambió; actualiza antes.");
    return sale;
  }
  // Rebuild the sale's lines in its own cycle while it is still open.
  @Patch("sales/:id") patchSale(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: SalePatchDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const before = await this.editable(tx, id, body.version);
        // A sale set aside stays set aside; one delivered on the spot is
        // delivered again. One delivered in part keeps its deliveries.
        const delivered = before.deliveries.length > 0;
        if (delivered && serializeOrder(before).deliveryStatus !== "DELIVERED")
          throw new ConflictException(
            "Esta venta ya se entregó en parte; registra el resto de la entrega en lugar de editarla.",
          );
        if (!delivered && !body.customerId)
          throw new BadRequestException(SET_ASIDE_NEEDS_CUSTOMER);
        const soldAt = before.deliveries[0]?.deliveredAt ?? new Date();
        await clearItems(tx, id);
        const items = await stockItems(tx, before.roundId, body.items, soldAt);
        await tx.order.update({
          where: { id },
          data: {
            customerId: await walkInCustomer(tx, body.customerId),
            notes: body.notes ?? null,
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
            items: { create: items },
          },
        });
        if (delivered) await deliverAll(tx, id, soldAt);
        else
          await allocateStock(tx, {
            orderId: id,
            at: soldAt,
            requireStock: true,
          });
        const after = serializeOrder(
          await tx.order.findUniqueOrThrow({
            where: { id },
            include: orderInclude,
          }),
        );
        if (decimal(after.paid).gt(after.total))
          throw new BadRequestException(
            `El total nuevo (L ${after.total}) queda por debajo de lo cobrado (L ${after.paid}). Anula un abono primero.`,
          );
        await audit(tx, req.actor.id, "Sale", id, "UPDATE", before, after);
        return after;
      },
      { timeout: 15000 },
    );
  }
  // Remove the sale with its delivery and payments; its stock becomes free.
  @Delete("sales/:id") deleteSale(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("version", ParseIntPipe) version: number,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const before = await this.editable(tx, id, version);
        if (await tx.customerCredit.count({ where: { orderId: id } }))
          throw new ConflictException(
            "La venta movió saldo de la cuenta del cliente; anula esos movimientos o sus pagos primero.",
          );
        await clearItems(tx, id);
        await tx.payment.deleteMany({ where: { orderId: id } });
        await tx.order.delete({ where: { id } });
        await audit(tx, req.actor.id, "Sale", id, "DELETE", before, {
          deleted: true,
        });
        return { ok: true };
      },
      { timeout: 15000 },
    );
  }
}
