import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import {
  AccountMoveDto,
  ApplyCreditDto,
  OrderCreditDto,
  VoidPaymentDto,
} from "./dto";
import { stockLock } from "./inventory";
import {
  decimal,
  money,
  orderBalance,
  orderInclude,
  serializeOrder,
} from "./math";
type Tx = Prisma.TransactionClient;
const SIGN: Record<string, number> = {
  DEPOSIT: 1,
  OVERPAY: 1,
  APPLY: -1,
  REFUND: -1,
};
export async function accountBalance(tx: Tx | Db, customerId: string) {
  const entries = await tx.customerCredit.findMany({
    where: { customerId, voidedAt: null },
  });
  return entries.reduce(
    (s, e) => s.add(decimal(e.amount).mul(SIGN[e.kind])),
    decimal(0),
  );
}
const notFuture = (date: string) => {
  if (new Date(date) > new Date())
    throw new BadRequestException("La fecha no puede ser futura.");
};
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(@Inject(Db) private db: Db) {}
  // Who owes us, across every cycle, and who has money with us.
  @Get("collections") async collections() {
    const [orders, credits] = await Promise.all([
      this.db.order.findMany({
        include: { ...orderInclude, round: true },
        orderBy: { createdAt: "asc" },
      }),
      this.db.customerCredit.findMany({
        where: { voidedAt: null },
        include: { customer: true },
      }),
    ]);
    const rows = new Map<string, any>();
    const row = (customer: any) => {
      if (!rows.has(customer.id))
        rows.set(customer.id, {
          customer: {
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            phoneCountryCode: customer.phoneCountryCode,
          },
          owed: decimal(0),
          orderCredit: decimal(0),
          account: decimal(0),
          orders: [] as any[],
        });
      return rows.get(customer.id);
    };
    for (const o of orders) {
      const { balance, credit } = orderBalance(o);
      if (balance.isZero() && credit.isZero()) continue;
      const r = row(o.customer);
      r.owed = r.owed.add(balance);
      r.orderCredit = r.orderCredit.add(credit);
      const view = serializeOrder(o);
      r.orders.push({
        id: o.id,
        kind: o.kind,
        version: o.version,
        createdAt: o.createdAt,
        round: { id: o.round.id, name: o.round.name, status: o.round.status },
        total: view.total,
        paid: view.paid,
        balance: view.balance,
        credit: view.credit,
        deliveryStatus: view.deliveryStatus,
      });
    }
    for (const c of credits) {
      const r = row(c.customer);
      r.account = r.account.add(decimal(c.amount).mul(SIGN[c.kind]));
    }
    const list = [...rows.values()]
      .filter((r) => r.owed.gt(0) || r.orderCredit.gt(0) || r.account.gt(0))
      .sort((a, b) => b.owed.comparedTo(a.owed))
      .map((r) => ({
        ...r,
        owed: money(r.owed),
        orderCredit: money(r.orderCredit),
        account: money(r.account),
      }));
    const sum = (k: "owed" | "account") =>
      money(list.reduce((s, r) => s.add(r[k]), decimal(0)));
    return { customers: list, owed: sum("owed"), account: sum("account") };
  }
  // Everything about one customer at a glance: what they buy, what they
  // owe, money held for them and their latest encargos and sales.
  @Get("customers/:id/summary") async summary(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const customer = await this.db.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("Cliente no encontrado.");
    const orders = await this.db.order.findMany({
      where: { customerId: id },
      include: { ...orderInclude, round: true },
      orderBy: { createdAt: "desc" },
    });
    const active = orders.filter((o) => !o.cancelledAt);
    const views = active.map((o) => serializeOrder(o));
    const sum = (k: "total" | "paid" | "balance") =>
      money(views.reduce((s, o) => s.add(o[k]), decimal(0)));
    return {
      customer,
      encargos: active.filter((o) => o.kind === "ENCARGO").length,
      sales: active.filter((o) => o.kind === "DIRECT").length,
      cancelled: orders.length - active.length,
      bought: sum("total"),
      paid: sum("paid"),
      owed: sum("balance"),
      account: money(await accountBalance(this.db, id)),
      lastAt: active[0]?.createdAt ?? null,
      orders: views.slice(0, 20).map((o: any) => ({
        id: o.id,
        kind: o.kind,
        createdAt: o.createdAt,
        round: { id: o.round.id, name: o.round.name },
        total: o.total,
        balance: o.balance,
        paymentStatus: o.paymentStatus,
        deliveryStatus: o.deliveryStatus,
        delivery: o.delivery,
        shippingFee: o.shippingFee,
        items: o.items.map((i: any) => ({
          productId: i.productId,
          supplierId: i.supplierId,
          name: i.product.name,
          unit: i.product.unit,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          lineTotal: i.lineTotal,
        })),
      })),
    };
  }
  @Get("customers/:id/account") async account(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const customer = await this.db.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("Cliente no encontrado.");
    const entries = await this.db.customerCredit.findMany({
      where: { customerId: id },
      include: { order: { include: { round: true } } },
      orderBy: { date: "desc" },
    });
    return {
      customerId: id,
      balance: money(await accountBalance(this.db, id)),
      entries: entries.map(({ order, ...e }) => ({
        ...e,
        amount: money(e.amount),
        order: order
          ? { id: order.id, kind: order.kind, roundName: order.round.name }
          : null,
      })),
    };
  }
  private async move(
    kind: "DEPOSIT" | "REFUND",
    customerId: string,
    body: AccountMoveDto,
    actor: string,
  ) {
    return this.db.$transaction(async (tx) => {
      await stockLock(tx);
      const prior = await tx.customerCredit.findUnique({
        where: { id: body.id },
      });
      if (prior) {
        if (prior.customerId !== customerId || prior.kind !== kind)
          throw new ConflictException("Identificador ya utilizado");
        return prior;
      }
      if (!(await tx.customer.findUnique({ where: { id: customerId } })))
        throw new NotFoundException("Cliente no encontrado.");
      if (decimal(body.amount).lte(0))
        throw new BadRequestException("El monto debe ser mayor que cero.");
      notFuture(body.date);
      if (
        kind === "REFUND" &&
        decimal(body.amount).gt(await accountBalance(tx, customerId))
      )
        throw new BadRequestException(
          "No se puede devolver más del saldo a favor del cliente.",
        );
      const entry = await tx.customerCredit.create({
        data: {
          id: body.id,
          customerId,
          kind,
          amount: body.amount,
          method: body.method,
          date: new Date(body.date),
          notes: body.notes || null,
        },
      });
      await audit(tx, actor, "CustomerCredit", entry.id, kind, null, entry);
      return entry;
    });
  }
  // Money a customer leaves with us to be used on future encargos.
  @Post("customers/:id/account/deposits") deposit(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AccountMoveDto,
    @Req() req: AuthRequest,
  ) {
    return this.move("DEPOSIT", id, body, req.actor.id);
  }
  @Post("customers/:id/account/refunds") refund(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AccountMoveDto,
    @Req() req: AuthRequest,
  ) {
    return this.move("REFUND", id, body, req.actor.id);
  }
  // Undo a deposit, refund or moved excess. Applications are undone by voiding
  // their payment on the encargo.
  @Post("customers/:id/account/:entryId/void") voidEntry(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body() body: VoidPaymentDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await stockLock(tx);
      const before = await tx.customerCredit.findUnique({
        where: { id: entryId },
      });
      if (!before || before.customerId !== id)
        throw new NotFoundException("Movimiento no encontrado.");
      if (before.kind === "APPLY")
        throw new BadRequestException(
          "Para deshacer un uso del saldo, anula ese pago en el encargo.",
        );
      if (before.voidedAt) return before;
      if (
        SIGN[before.kind] > 0 &&
        decimal(before.amount).gt(await accountBalance(tx, id))
      )
        throw new BadRequestException(
          "Ese saldo ya se usó; anula primero los pagos hechos con él.",
        );
      const after = await tx.customerCredit.update({
        where: { id: entryId },
        data: { voidedAt: new Date(), voidReason: body.reason },
      });
      if (before.orderId)
        await tx.order.update({
          where: { id: before.orderId },
          data: { version: { increment: 1 } },
        });
      await audit(
        tx,
        req.actor.id,
        "CustomerCredit",
        entryId,
        "VOID",
        before,
        after,
      );
      return after;
    });
  }
  // Pay an encargo or sale with the customer's account.
  @Post("orders/:id/apply-credit") applyCredit(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ApplyCreditDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await stockLock(tx);
      const order = await tx.order.findUniqueOrThrow({
        where: { id },
        include: orderInclude,
      });
      if (await tx.payment.findUnique({ where: { id: body.id } }))
        return serializeOrder(order);
      if (order.version !== body.version)
        throw new ConflictException("El encargo cambió; actualiza antes.");
      notFuture(body.date);
      const amount = decimal(body.amount);
      const { balance } = orderBalance(order);
      const available = await accountBalance(tx, order.customerId);
      if (amount.lte(0) || amount.gt(balance))
        throw new BadRequestException(
          "El monto debe ser mayor a cero y no superar el saldo pendiente.",
        );
      if (amount.gt(available))
        throw new BadRequestException(
          `El cliente solo tiene L ${money(available)} a favor.`,
        );
      const payment = await tx.payment.create({
        data: {
          id: body.id,
          orderId: id,
          amount,
          method: "CREDIT",
          paidAt: new Date(body.date),
          notes: "Pagado con saldo a favor",
        },
      });
      await tx.customerCredit.create({
        data: {
          id: crypto.randomUUID(),
          customerId: order.customerId,
          kind: "APPLY",
          amount,
          date: new Date(body.date),
          orderId: id,
          paymentId: payment.id,
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
        "APPLY_CREDIT",
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
  // Keep what a customer paid over the total as account credit.
  @Post("orders/:id/credit-to-account") creditToAccount(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: OrderCreditDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await stockLock(tx);
      const order = await tx.order.findUniqueOrThrow({
        where: { id },
        include: orderInclude,
      });
      if (await tx.customerCredit.findUnique({ where: { id: body.id } }))
        return serializeOrder(order);
      if (order.version !== body.version)
        throw new ConflictException("El encargo cambió; actualiza antes.");
      const { credit } = orderBalance(order);
      if (credit.lte(0))
        throw new BadRequestException("Este encargo no tiene pago de más.");
      const entry = await tx.customerCredit.create({
        data: {
          id: body.id,
          customerId: order.customerId,
          kind: "OVERPAY",
          amount: credit,
          date: new Date(),
          orderId: id,
          notes: "Pago de más en el encargo",
        },
      });
      await tx.order.update({
        where: { id },
        data: { version: { increment: 1 } },
      });
      await audit(
        tx,
        req.actor.id,
        "CustomerCredit",
        entry.id,
        "OVERPAY",
        null,
        entry,
      );
      return serializeOrder(
        await tx.order.findUniqueOrThrow({
          where: { id },
          include: orderInclude,
        }),
      );
    });
  }
}
