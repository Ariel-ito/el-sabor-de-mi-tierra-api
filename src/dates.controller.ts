import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import { DateFixDto } from "./dto";
import { stockLock } from "./inventory";
import { money } from "./math";
import { qtyText } from "./units";
type Tx = Prisma.TransactionClient;
// Fixing dates entered late: when an encargo or sale was made, delivered and
// paid, and when purchases arrived. Every change is audited.
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class DatesController {
  constructor(@Inject(Db) private db: Db) {}
  @Get("rounds/:id/dates") async list(@Param("id", ParseUUIDPipe) id: string) {
    if (!(await this.db.round.findUnique({ where: { id } })))
      throw new NotFoundException("Ciclo no encontrado.");
    const [orders, receipts] = await Promise.all([
      this.db.order.findMany({
        where: { roundId: id, cancelledAt: null },
        include: {
          customer: true,
          items: { include: { product: true } },
          deliveries: {
            include: { items: true },
            orderBy: { deliveredAt: "asc" },
          },
          payments: { orderBy: { paidAt: "asc" } },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.db.receipt.findMany({
        where: { purchase: { roundId: id, kind: "PURCHASE" } },
        include: { purchase: { include: { supplier: true } } },
        orderBy: { receivedAt: "asc" },
      }),
    ]);
    return {
      orders: orders.map((o) => ({
        id: o.id,
        kind: o.kind,
        customer: o.customer.name,
        createdAt: o.createdAt,
        deliveries: o.deliveries.map((d) => ({
          id: d.id,
          deliveredAt: d.deliveredAt,
          items: d.items
            .map((di) => {
              const item = o.items.find((i) => i.id === di.orderItemId);
              return item
                ? `${qtyText(di.quantity, item.product.unit)} de ${item.product.name}`
                : "";
            })
            .filter(Boolean)
            .join(", "),
        })),
        payments: o.payments.map((p) => ({
          id: p.id,
          paidAt: p.paidAt,
          amount: money(p.amount),
          method: p.method,
          voided: !!p.voidedAt,
        })),
      })),
      receipts: receipts.map((r) => ({
        id: r.id,
        supplier: r.purchase.supplier.name,
        invoice: r.invoice,
        receivedAt: r.receivedAt,
        total: money(r.total),
      })),
    };
  }
  @Patch("rounds/:id/dates") fix(
    @Param("id", ParseUUIDPipe) roundId: string,
    @Body() body: DateFixDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const now = new Date();
        const orderIds = new Set<string>();
        for (const c of body.changes) {
          const date = new Date(c.date);
          if (date > now)
            throw new BadRequestException("Ninguna fecha puede ser futura.");
          if (c.kind === "order") {
            const o = await tx.order.findUnique({ where: { id: c.id } });
            if (!o || o.roundId !== roundId) throw this.missing();
            await tx.order.update({
              where: { id: c.id },
              data: { createdAt: date, version: { increment: 1 } },
            });
            await this.log(tx, req, "Order", c.id, o.createdAt, date);
            orderIds.add(c.id);
          } else if (c.kind === "delivery") {
            const d = await tx.delivery.findUnique({
              where: { id: c.id },
              include: { order: true },
            });
            if (!d || d.order.roundId !== roundId) throw this.missing();
            await tx.delivery.update({
              where: { id: c.id },
              data: { deliveredAt: date },
            });
            await tx.order.update({
              where: { id: d.orderId },
              data: { version: { increment: 1 } },
            });
            await this.log(tx, req, "Delivery", c.id, d.deliveredAt, date);
            orderIds.add(d.orderId);
          } else if (c.kind === "payment") {
            const p = await tx.payment.findUnique({
              where: { id: c.id },
              include: { order: true },
            });
            if (!p || p.order.roundId !== roundId) throw this.missing();
            await tx.payment.update({
              where: { id: c.id },
              data: { paidAt: date },
            });
            // A payment made with account credit moves its account entry too.
            await tx.customerCredit.updateMany({
              where: { paymentId: c.id },
              data: { date },
            });
            await tx.order.update({
              where: { id: p.orderId },
              data: { version: { increment: 1 } },
            });
            await this.log(tx, req, "Payment", c.id, p.paidAt, date);
          } else {
            const r = await tx.receipt.findUnique({
              where: { id: c.id },
              include: { purchase: true, items: true },
            });
            if (!r || r.purchase.roundId !== roundId) throw this.missing();
            const shift = date.getTime() - r.receivedAt.getTime();
            await tx.receipt.update({
              where: { id: c.id },
              data: { receivedAt: date },
            });
            // Expiry was counted from the arrival; it moves with it.
            for (const i of r.items)
              if (i.expiresAt)
                await tx.receiptItem.update({
                  where: { id: i.id },
                  data: { expiresAt: new Date(i.expiresAt.getTime() + shift) },
                });
            await tx.purchase.update({
              where: { id: r.purchaseId },
              data: { version: { increment: 1 } },
            });
            await this.log(tx, req, "Receipt", c.id, r.receivedAt, date);
            const fed = await tx.stockAllocation.findMany({
              where: { receiptItem: { receiptId: c.id }, delivered: { gt: 0 } },
              include: { orderItem: true },
            });
            for (const a of fed) orderIds.add(a.orderItem.orderId);
          }
        }
        // Product can't be delivered before it arrived.
        for (const orderId of orderIds) {
          const order = await tx.order.findUniqueOrThrow({
            where: { id: orderId },
            include: {
              customer: true,
              deliveries: { include: { items: true } },
              items: {
                include: {
                  product: true,
                  allocations: {
                    where: { delivered: { gt: 0 } },
                    include: { receiptItem: { include: { receipt: true } } },
                  },
                },
              },
            },
          });
          // Each delivery needs at least one of its lots already received.
          for (const d of order.deliveries)
            for (const di of d.items) {
              const item = order.items.find((i) => i.id === di.orderItemId);
              const arrivals = (item?.allocations ?? []).map((a) =>
                a.receiptItem.receipt.receivedAt.getTime(),
              );
              if (!item || !arrivals.length) continue;
              const first = Math.min(...arrivals);
              if (d.deliveredAt.getTime() < first)
                throw new BadRequestException(
                  `${order.customer.name}: la entrega de ${item.product.name} quedaría antes de que llegara el producto (${new Date(first).toISOString().slice(0, 10)}). Corrige también la fecha de esa recepción.`,
                );
            }
        }
        return { changed: body.changes.length };
      },
      { timeout: 30000 },
    );
  }
  private missing() {
    return new NotFoundException(
      "Un registro no pertenece a este ciclo o ya no existe; actualiza.",
    );
  }
  private log(
    tx: Tx,
    req: AuthRequest,
    entity: string,
    id: string,
    before: Date,
    after: Date,
  ) {
    return audit(
      tx,
      req.actor.id,
      entity,
      id,
      "DATE",
      { date: before },
      { date: after },
    );
  }
}
