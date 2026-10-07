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
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import {
  DistributionDto,
  FinanceCategoryDto,
  FinanceCategoryPatchDto,
  MovementDto,
  MovementPatchDto,
  MovementPayDto,
  RecurringDto,
  RecurringPatchDto,
  ReimburseDto,
} from "./dto";
import {
  Entry,
  monthRange,
  OWNERS,
  recurringPeriods,
  summarize,
} from "./finance";
import { decimal, money } from "./math";
type Tx = Prisma.TransactionClient;
// Categories the ledger fills by itself from cobros and facturas.
const AUTOMATIC = ["SALE", "PRODUCT_PURCHASE"];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const currentMonth = () =>
  new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 7);
const validMonth = (month?: string) => {
  if (!month) return currentMonth();
  if (!MONTH.test(month))
    throw new BadRequestException("Mes inválido (AAAA-MM).");
  return month;
};
const movementInclude = {
  category: true,
  round: { select: { id: true, name: true } },
} as const;
type MovementRow = Prisma.FinanceMovementGetPayload<{
  include: typeof movementInclude;
}>;
// Ledger line shared by typed-in movements and those derived from operations.
type Line = {
  id: string;
  source: "MANUAL" | "RECURRING" | "INVOICE" | "PAYMENT" | "ACCOUNT";
  kind: "INCOME" | "EXPENSE";
  status: string;
  date: Date;
  amount: string;
  category: {
    id: string;
    name: string;
    systemKey: string | null;
    inResult: boolean;
  };
  description: string;
  method: string | null;
  paidBy: string;
  personalMode: string | null;
  reimbursedAt: Date | null;
  owner: string | null;
  groupId: string | null;
  round: { id: string; name: string } | null;
  recurringId: string | null;
  version: number | null;
};
const fromMovement = (m: MovementRow): Line => ({
  id: m.id,
  source: m.recurringId ? "RECURRING" : "MANUAL",
  kind: m.kind as Line["kind"],
  status: m.status,
  date: m.date,
  amount: money(m.amount),
  category: {
    id: m.category.id,
    name: m.category.name,
    systemKey: m.category.systemKey,
    inResult: m.category.inResult,
  },
  description: m.description,
  method: m.method,
  paidBy: m.paidBy,
  personalMode: m.personalMode,
  reimbursedAt: m.reimbursedAt,
  owner: m.owner,
  groupId: m.groupId,
  round: m.round,
  recurringId: m.recurringId,
  version: m.version,
});
const toEntry = (l: Line): Entry => ({
  kind: l.kind,
  status: l.status,
  amount: l.amount,
  systemKey: l.category.systemKey,
  inResult: l.category.inResult,
  categoryName: l.category.name,
  paidBy: l.paidBy,
  personalMode: l.personalMode,
  reimbursedAt: l.reimbursedAt,
  owner: l.owner,
  recurring: l.source === "RECURRING",
});
@ApiBearerAuth()
@Controller("finance")
@UseGuards(AuthGuard)
export class FinanceController {
  constructor(@Inject(Db) private db: Db) {}
  // Create the PENDING movement of every recurring period due up to now.
  private async generateRecurring() {
    const now = new Date();
    const templates = await this.db.recurringExpense.findMany({
      where: { active: true },
      include: { category: true },
    });
    const data = templates.flatMap((t) =>
      recurringPeriods(t, now).map((p) => ({
        id: crypto.randomUUID(),
        kind: t.category.kind,
        status: "PENDING",
        date: p.date,
        amount: t.amount,
        categoryId: t.categoryId,
        description: t.description,
        recurringId: t.id,
        periodKey: p.periodKey,
      })),
    );
    if (data.length)
      await this.db.financeMovement.createMany({ data, skipDuplicates: true });
  }
  private async systemCategory(tx: Tx | Db, systemKey: string) {
    return tx.financeCategory.findUniqueOrThrow({ where: { systemKey } });
  }
  // Every ledger line, optionally limited to a date range or a cycle.
  private async lines(range?: { start: Date; end: Date }, roundId?: string) {
    const date = range ? { gte: range.start, lt: range.end } : undefined;
    const [movements, receipts, payments, sale, purchase, account] =
      await Promise.all([
        this.db.financeMovement.findMany({
          where: { ...(date ? { date } : {}), ...(roundId ? { roundId } : {}) },
          include: movementInclude,
        }),
        this.db.receipt.findMany({
          where: {
            ...(date ? { receivedAt: date } : {}),
            ...(roundId ? { purchase: { roundId } } : {}),
          },
          include: {
            purchase: { include: { supplier: true, round: true } },
          },
        }),
        this.db.payment.findMany({
          where: {
            voidedAt: null,
            // Paid from account credit: that money entered as a deposit.
            method: { not: "CREDIT" },
            ...(date ? { paidAt: date } : {}),
            ...(roundId ? { order: { roundId } } : {}),
          },
          include: { order: { include: { customer: true, round: true } } },
        }),
        this.systemCategory(this.db, "SALE"),
        this.systemCategory(this.db, "PRODUCT_PURCHASE"),
        // Advances received and refunds given from customers' accounts.
        this.db.customerCredit.findMany({
          where: {
            voidedAt: null,
            kind: { in: ["DEPOSIT", "REFUND"] },
            ...(date ? { date } : {}),
            ...(roundId ? { order: { roundId } } : {}),
          },
          include: { customer: true, order: { include: { round: true } } },
        }),
      ]);
    const auto = {
      status: "PAID",
      paidBy: "BUSINESS",
      personalMode: null,
      reimbursedAt: null,
      owner: null,
      groupId: null,
      recurringId: null,
      version: null,
    };
    const lines: Line[] = [
      ...movements.map(fromMovement),
      ...receipts.map((r): Line => ({
        ...auto,
        id: r.id,
        source: "INVOICE",
        kind: "EXPENSE",
        date: r.receivedAt,
        amount: money(r.total),
        category: purchase,
        description: `Factura ${r.invoice} · ${r.purchase.supplier.name}`,
        method: null,
        round: { id: r.purchase.round.id, name: r.purchase.round.name },
      })),
      ...payments.map((p): Line => ({
        ...auto,
        id: p.id,
        source: "PAYMENT",
        kind: "INCOME",
        date: p.paidAt,
        amount: money(p.amount),
        category: sale,
        description: `${p.order.kind === "DIRECT" ? "Venta" : "Cobro"} · ${p.order.customer.name}`,
        method: p.method,
        round: { id: p.order.round.id, name: p.order.round.name },
      })),
      ...account.map((e): Line => ({
        ...auto,
        id: e.id,
        source: "ACCOUNT",
        kind: "INCOME",
        date: e.date,
        amount: money(e.kind === "REFUND" ? decimal(e.amount).neg() : e.amount),
        category: sale,
        description: `${e.kind === "REFUND" ? "Devolución de saldo" : "Saldo a favor"} · ${e.customer.name}`,
        method: e.method,
        round: e.order
          ? { id: e.order.round.id, name: e.order.round.name }
          : null,
      })),
    ];
    return lines.sort((a, b) => b.date.getTime() - a.date.getTime());
  }
  @Get("owners") owners() {
    return OWNERS;
  }
  // ---- Categories ----
  @Get("categories") async categories() {
    const rows = await this.db.financeCategory.findMany({
      include: { _count: { select: { movements: true, recurring: true } } },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    });
    return rows.map(({ _count, ...c }) => ({
      ...c,
      used: _count.movements + _count.recurring > 0,
      automatic: AUTOMATIC.includes(c.systemKey ?? ""),
    }));
  }
  @Post("categories") async createCategory(
    @Body() body: FinanceCategoryDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const exists = await tx.financeCategory.findFirst({
        where: {
          kind: body.kind,
          name: { equals: body.name.trim(), mode: "insensitive" },
        },
      });
      if (exists)
        throw new ConflictException("Ya existe una categoría con ese nombre.");
      const created = await tx.financeCategory.create({
        data: {
          name: body.name.trim(),
          kind: body.kind,
          inResult: body.inResult ?? true,
        },
      });
      await audit(
        tx,
        req.actor.id,
        "FinanceCategory",
        created.id,
        "CREATE",
        null,
        created,
      );
      return created;
    });
  }
  @Patch("categories/:id") async patchCategory(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: FinanceCategoryPatchDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await tx.financeCategory.findUnique({ where: { id } });
      if (!before) throw new NotFoundException("Categoría no encontrada.");
      if (
        before.systemKey &&
        (body.active === false ||
          (body.inResult != null && body.inResult !== before.inResult))
      )
        throw new BadRequestException(
          "Esta categoría la usa el sistema: solo se puede cambiar su nombre.",
        );
      if (body.name) {
        const clash = await tx.financeCategory.findFirst({
          where: {
            id: { not: id },
            kind: before.kind,
            name: { equals: body.name.trim(), mode: "insensitive" },
          },
        });
        if (clash)
          throw new ConflictException(
            "Ya existe una categoría con ese nombre.",
          );
      }
      const after = await tx.financeCategory.update({
        where: { id },
        data: {
          name: body.name?.trim(),
          inResult: body.inResult ?? undefined,
          active: body.active ?? undefined,
        },
      });
      await audit(
        tx,
        req.actor.id,
        "FinanceCategory",
        id,
        "UPDATE",
        before,
        after,
      );
      return after;
    });
  }
  // Unused categories are removed; used ones can only be deactivated.
  @Delete("categories/:id") async deleteCategory(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await tx.financeCategory.findUnique({
        where: { id },
        include: { _count: { select: { movements: true, recurring: true } } },
      });
      if (!before) throw new NotFoundException("Categoría no encontrada.");
      if (before.systemKey)
        throw new BadRequestException("Esta categoría la usa el sistema.");
      if (before._count.movements + before._count.recurring)
        throw new ConflictException(
          "La categoría tiene movimientos; desactívala en lugar de borrarla.",
        );
      await tx.financeCategory.delete({ where: { id } });
      await audit(tx, req.actor.id, "FinanceCategory", id, "DELETE", before, {
        deleted: true,
      });
      return { ok: true };
    });
  }
  // ---- Ledger and movements ----
  @Get("ledger") async ledger(
    @Query("month") month?: string,
    @Query("roundId", new ParseUUIDPipe({ optional: true })) roundId?: string,
  ) {
    await this.generateRecurring();
    const lines = roundId
      ? await this.lines(undefined, roundId)
      : await this.lines(monthRange(validMonth(month)));
    // Pending items stay visible until settled, whatever month they belong to.
    const [pending, owed] = await Promise.all([
      this.db.financeMovement.findMany({
        where: { status: "PENDING", date: { lte: new Date() } },
        include: movementInclude,
        orderBy: { date: "asc" },
      }),
      this.db.financeMovement.findMany({
        where: {
          status: "PAID",
          personalMode: "REIMBURSE",
          reimbursedAt: null,
        },
        include: movementInclude,
        orderBy: { date: "asc" },
      }),
    ]);
    return {
      month: roundId ? null : validMonth(month),
      lines,
      pending: pending.map(fromMovement),
      owed: owed.map(fromMovement),
    };
  }
  private async validMovement(tx: Tx, body: MovementDto) {
    const category = await tx.financeCategory.findUnique({
      where: { id: body.categoryId },
    });
    if (!category || !category.active)
      throw new BadRequestException("Categoría inexistente o desactivada.");
    if (category.kind !== body.kind)
      throw new BadRequestException(
        "La categoría no corresponde al tipo de movimiento.",
      );
    if (AUTOMATIC.includes(category.systemKey ?? ""))
      throw new BadRequestException(
        category.systemKey === "SALE"
          ? "Las ventas entran solas al registrar cobros."
          : "Las compras de producto entran solas al registrar la factura del proveedor.",
      );
    if (category.systemKey === "PROFIT_DISTRIBUTION")
      throw new BadRequestException(
        "El reparto de ganancias se registra desde Dueños.",
      );
    if (decimal(body.amount).lte(0))
      throw new BadRequestException("El monto debe ser mayor que cero.");
    if (new Date(body.date) > new Date(Date.now() + 86400000))
      throw new BadRequestException("La fecha no puede ser futura.");
    const paidBy =
      body.kind === "EXPENSE" ? (body.paidBy ?? "BUSINESS") : "BUSINESS";
    if (paidBy !== "BUSINESS" && !body.personalMode)
      throw new BadRequestException(
        "Indica si al dueño se le devuelve el dinero o si lo aporta al negocio.",
      );
    const owner =
      category.systemKey === "OWNER_CONTRIBUTION" ? (body.owner ?? null) : null;
    if (category.systemKey === "OWNER_CONTRIBUTION" && !owner)
      throw new BadRequestException("Indica qué dueño hizo el aporte.");
    if (
      body.roundId &&
      !(await tx.round.findUnique({ where: { id: body.roundId } }))
    )
      throw new BadRequestException("Ciclo inexistente.");
    return {
      kind: body.kind,
      date: new Date(body.date),
      amount: body.amount,
      categoryId: body.categoryId,
      description: body.description.trim(),
      method: body.method ?? null,
      paidBy,
      personalMode: paidBy === "BUSINESS" ? null : body.personalMode!,
      owner,
      roundId: body.roundId ?? null,
    };
  }
  @Post("movements") async createMovement(
    @Body() body: MovementDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const prior = await tx.financeMovement.findUnique({
        where: { id: body.id },
        include: movementInclude,
      });
      if (prior) return fromMovement(prior);
      const data = await this.validMovement(tx, body);
      const created = await tx.financeMovement.create({
        data: { id: body.id, ...data },
        include: movementInclude,
      });
      await audit(
        tx,
        req.actor.id,
        "FinanceMovement",
        created.id,
        "CREATE",
        null,
        created,
      );
      return fromMovement(created);
    });
  }
  private async current(tx: Tx, id: string, version: number) {
    const movement = await tx.financeMovement.findUnique({
      where: { id },
      include: movementInclude,
    });
    if (!movement) throw new NotFoundException("Movimiento no encontrado.");
    if (movement.version !== version)
      throw new ConflictException("El movimiento cambió; actualiza antes.");
    return movement;
  }
  @Patch("movements/:id") async patchMovement(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: MovementPatchDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await this.current(tx, id, body.version);
      if (before.groupId)
        throw new BadRequestException(
          "Un reparto de ganancias no se edita; elimínalo y regístralo de nuevo.",
        );
      const data = await this.validMovement(tx, body);
      const after = await tx.financeMovement.update({
        where: { id },
        data: {
          ...data,
          reimbursedAt:
            data.personalMode === "REIMBURSE" && data.paidBy === before.paidBy
              ? before.reimbursedAt
              : null,
          version: { increment: 1 },
        },
        include: movementInclude,
      });
      await audit(
        tx,
        req.actor.id,
        "FinanceMovement",
        id,
        "UPDATE",
        before,
        after,
      );
      return fromMovement(after);
    });
  }
  // A recurring period is skipped rather than deleted so it is not generated
  // again; a distribution is removed with its other half.
  @Delete("movements/:id") async deleteMovement(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("version", ParseIntPipe) version: number,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await this.current(tx, id, version);
      if (before.recurringId) {
        const after = await tx.financeMovement.update({
          where: { id },
          data: { status: "SKIPPED", version: { increment: 1 } },
        });
        await audit(
          tx,
          req.actor.id,
          "FinanceMovement",
          id,
          "SKIP",
          before,
          after,
        );
        return { ok: true, skipped: true };
      }
      const where = before.groupId ? { groupId: before.groupId } : { id };
      await tx.financeMovement.deleteMany({ where });
      await audit(tx, req.actor.id, "FinanceMovement", id, "DELETE", before, {
        deleted: true,
      });
      return { ok: true };
    });
  }
  @Post("movements/:id/pay") async payMovement(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: MovementPayDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await this.current(tx, id, body.version);
      if (before.status === "PAID") return fromMovement(before);
      const paidBy =
        before.kind === "EXPENSE" ? (body.paidBy ?? "BUSINESS") : "BUSINESS";
      if (paidBy !== "BUSINESS" && !body.personalMode)
        throw new BadRequestException(
          "Indica si al dueño se le devuelve el dinero o si lo aporta al negocio.",
        );
      if (decimal(body.amount).lte(0))
        throw new BadRequestException("El monto debe ser mayor que cero.");
      const after = await tx.financeMovement.update({
        where: { id },
        data: {
          status: "PAID",
          date: new Date(body.date),
          amount: body.amount,
          method: body.method ?? null,
          paidBy,
          personalMode: paidBy === "BUSINESS" ? null : body.personalMode!,
          version: { increment: 1 },
        },
        include: movementInclude,
      });
      await audit(
        tx,
        req.actor.id,
        "FinanceMovement",
        id,
        "PAY",
        before,
        after,
      );
      return fromMovement(after);
    });
  }
  @Post("movements/:id/reimburse") async reimburse(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ReimburseDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await this.current(tx, id, body.version);
      if (before.personalMode !== "REIMBURSE" || before.status !== "PAID")
        throw new BadRequestException(
          "Este movimiento no está pendiente de devolver.",
        );
      if (before.reimbursedAt) return fromMovement(before);
      const after = await tx.financeMovement.update({
        where: { id },
        data: { reimbursedAt: new Date(body.date), version: { increment: 1 } },
        include: movementInclude,
      });
      await audit(
        tx,
        req.actor.id,
        "FinanceMovement",
        id,
        "REIMBURSE",
        before,
        after,
      );
      return fromMovement(after);
    });
  }
  // ---- Recurring expenses ----
  @Get("recurring") async recurring() {
    await this.generateRecurring();
    const rows = await this.db.recurringExpense.findMany({
      include: {
        category: true,
        movements: {
          where: { status: "PENDING" },
          select: { id: true },
        },
      },
      orderBy: [{ active: "desc" }, { description: "asc" }],
    });
    return rows.map(({ movements, ...r }) => ({
      ...r,
      amount: money(r.amount),
      pendingCount: movements.length,
    }));
  }
  private async validRecurring(tx: Tx, body: RecurringDto) {
    const category = await tx.financeCategory.findUnique({
      where: { id: body.categoryId },
    });
    if (!category || !category.active || category.kind !== "EXPENSE")
      throw new BadRequestException("Elige una categoría de gasto activa.");
    if (
      ["PRODUCT_PURCHASE", "PROFIT_DISTRIBUTION"].includes(
        category.systemKey ?? "",
      )
    )
      throw new BadRequestException(
        "Esa categoría no admite gastos recurrentes.",
      );
    if (decimal(body.amount).lte(0))
      throw new BadRequestException("El monto debe ser mayor que cero.");
    const max = body.frequency === "MONTHLY" ? 28 : 6;
    if (body.day > max || (body.frequency === "MONTHLY" && body.day < 1))
      throw new BadRequestException(
        body.frequency === "MONTHLY"
          ? "El día del mes va de 1 a 28."
          : "El día de la semana va de 0 (domingo) a 6 (sábado).",
      );
    return {
      description: body.description.trim(),
      categoryId: body.categoryId,
      amount: body.amount,
      frequency: body.frequency,
      day: body.day,
      startsOn: new Date(body.startsOn),
    };
  }
  @Post("recurring") async createRecurring(
    @Body() body: RecurringDto,
    @Req() req: AuthRequest,
  ) {
    const created = await this.db.$transaction(async (tx) => {
      const data = await this.validRecurring(tx, body);
      const row = await tx.recurringExpense.create({ data });
      await audit(
        tx,
        req.actor.id,
        "RecurringExpense",
        row.id,
        "CREATE",
        null,
        row,
      );
      return row;
    });
    await this.generateRecurring();
    return created;
  }
  // Changes apply to periods still pending and to future ones.
  @Patch("recurring/:id") async patchRecurring(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RecurringPatchDto,
    @Req() req: AuthRequest,
  ) {
    const after = await this.db.$transaction(async (tx) => {
      const before = await tx.recurringExpense.findUnique({ where: { id } });
      if (!before)
        throw new NotFoundException("Gasto recurrente no encontrado.");
      if (before.version !== body.version)
        throw new ConflictException(
          "El gasto recurrente cambió; actualiza antes.",
        );
      const data = await this.validRecurring(tx, body);
      const row = await tx.recurringExpense.update({
        where: { id },
        data: { ...data, active: body.active, version: { increment: 1 } },
      });
      await tx.financeMovement.updateMany({
        where: { recurringId: id, status: "PENDING" },
        data: {
          amount: data.amount,
          description: data.description,
          categoryId: data.categoryId,
          version: { increment: 1 },
        },
      });
      await audit(
        tx,
        req.actor.id,
        "RecurringExpense",
        id,
        "UPDATE",
        before,
        row,
      );
      return row;
    });
    await this.generateRecurring();
    return after;
  }
  // ---- Owners ----
  @Post("distributions") async distribute(
    @Body() body: DistributionDto,
    @Req() req: AuthRequest,
  ) {
    const total = decimal(body.ariel).add(body.maria);
    if (total.lte(0))
      throw new BadRequestException("El reparto debe ser mayor que cero.");
    const available = decimal(
      summarize((await this.lines()).map(toEntry)).available,
    );
    return this.db.$transaction(async (tx) => {
      const prior = await tx.financeMovement.findMany({
        where: { groupId: body.id },
        include: movementInclude,
      });
      if (prior.length) return prior.map(fromMovement);
      if (total.gt(available))
        throw new BadRequestException(
          `Solo hay L ${money(available)} de ganancia disponible para repartir.`,
        );
      const category = await this.systemCategory(tx, "PROFIT_DISTRIBUTION");
      const rows = [];
      for (const owner of OWNERS) {
        const amount = owner.key === "ARIEL" ? body.ariel : body.maria;
        if (decimal(amount).lte(0)) continue;
        rows.push(
          await tx.financeMovement.create({
            data: {
              id: crypto.randomUUID(),
              kind: "EXPENSE",
              date: new Date(body.date),
              amount,
              categoryId: category.id,
              description:
                body.description?.trim() ||
                `Reparto de ganancias · ${owner.name}`,
              method: body.method ?? null,
              owner: owner.key,
              groupId: body.id,
            },
            include: movementInclude,
          }),
        );
      }
      await audit(
        tx,
        req.actor.id,
        "Distribution",
        body.id,
        "CREATE",
        null,
        rows,
      );
      return rows.map(fromMovement);
    });
  }
  // ---- Summary ----
  @Get("summary") async summary(@Query("month") month?: string) {
    await this.generateRecurring();
    const selected = validMonth(month);
    const all = await this.lines();
    const allTime = summarize(all.map(toEntry));
    const { start, end } = monthRange(selected);
    const inMonth = all.filter((l) => l.date >= start && l.date < end);
    // Six months ending at the selected one, for the trend.
    const months = Array.from({ length: 6 }, (_, i) => {
      const [y, m] = selected.split("-").map(Number);
      const d = new Date(Date.UTC(y, m - 1 - (5 - i), 1));
      const key = d.toISOString().slice(0, 7);
      const r = monthRange(key);
      const s = summarize(
        all.filter((l) => l.date >= r.start && l.date < r.end).map(toEntry),
      );
      return {
        month: key,
        income: s.income,
        expense: s.expense,
        result: s.result,
      };
    });
    // Operating expenses tied to a cycle reduce that cycle's result.
    const cycles = new Map<
      string,
      { id: string; name: string; expenses: Prisma.Decimal }
    >();
    for (const l of all)
      if (
        l.round &&
        (l.source === "MANUAL" || l.source === "RECURRING") &&
        l.status === "PAID" &&
        l.kind === "EXPENSE" &&
        l.category.inResult
      ) {
        const c = cycles.get(l.round.id) ?? {
          ...l.round,
          expenses: decimal(0),
        };
        c.expenses = c.expenses.add(l.amount);
        cycles.set(l.round.id, c);
      }
    return {
      month: selected,
      monthly: summarize(inMonth.map(toEntry)),
      allTime,
      months,
      owners: OWNERS.map((o) => ({
        ...o,
        contributed: allTime.contributed[o.key],
        owed: allTime.owedToOwners[o.key],
        distributed: money(
          all
            .filter(
              (l) =>
                l.category.systemKey === "PROFIT_DISTRIBUTION" &&
                l.owner === o.key,
            )
            .reduce((a, l) => a.add(l.amount), decimal(0)),
        ),
        suggested: money(decimal(allTime.available).mul(o.share)),
      })),
      cycleExpenses: [...cycles.values()].map((c) => ({
        ...c,
        expenses: money(c.expenses),
      })),
    };
  }
}
