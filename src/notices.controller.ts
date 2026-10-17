import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { AuthGuard, AuthRequest, Db } from "./core";
import { NoticeDto } from "./dto";
import { WALK_IN } from "./sales.controller";
// "Clientes por avisar": who has no encargo or sale in the cycle yet, most
// recent buyers first, and who was already told the cycle is taking encargos.
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class NoticesController {
  constructor(@Inject(Db) private db: Db) {}
  private async round(id: string) {
    if (!(await this.db.round.findUnique({ where: { id } })))
      throw new NotFoundException("Ciclo no encontrado.");
  }
  @Get("rounds/:id/notices") async list(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    await this.round(id);
    const [customers, inRound, notices, users] = await Promise.all([
      this.db.customer.findMany({
        where: { name: { not: WALK_IN } },
        orderBy: { name: "asc" },
      }),
      this.db.order.findMany({
        where: { roundId: id, cancelledAt: null },
        select: { customerId: true },
        distinct: ["customerId"],
      }),
      this.db.customerNotice.findMany({ where: { roundId: id } }),
      this.db.user.findMany({ select: { id: true, name: true } }),
    ]);
    const ordered = new Set(inRound.map((o) => o.customerId));
    const pending = customers.filter((c) => !ordered.has(c.id));
    // Each customer's latest encargo or sale, and how many they have made.
    const history = await this.db.order.findMany({
      where: {
        cancelledAt: null,
        customerId: { in: pending.map((c) => c.id) },
      },
      select: { id: true, customerId: true },
      orderBy: { createdAt: "desc" },
    });
    const latest = new Map<string, string>(),
      count = new Map<string, number>();
    for (const o of history) {
      if (!latest.has(o.customerId)) latest.set(o.customerId, o.id);
      count.set(o.customerId, (count.get(o.customerId) ?? 0) + 1);
    }
    const last = new Map(
      (
        await this.db.order.findMany({
          where: { id: { in: [...latest.values()] } },
          include: { round: true, items: { include: { product: true } } },
        })
      ).map((o) => [o.customerId, o]),
    );
    const told = new Map(notices.map((n) => [n.customerId, n]));
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      customers: pending
        .map((c) => {
          const o = last.get(c.id),
            n = told.get(c.id);
          return {
            customer: {
              id: c.id,
              name: c.name,
              phone: c.phone,
              phoneCountryCode: c.phoneCountryCode,
            },
            purchases: count.get(c.id) ?? 0,
            last: o
              ? {
                  at: o.createdAt,
                  round: o.round.name,
                  products: [...new Set(o.items.map((i) => i.product.name))],
                }
              : null,
            notified: n
              ? { at: n.notifiedAt, by: names.get(n.actorId) ?? null }
              : null,
          };
        })
        .sort(
          (a, b) =>
            (b.last ? +b.last.at : 0) - (a.last ? +a.last.at : 0) ||
            a.customer.name.localeCompare(b.customer.name, "es"),
        ),
      // Told this cycle, and how many of them already placed an encargo.
      notified: notices.length,
      notifiedOrdered: notices.filter((n) => ordered.has(n.customerId)).length,
    };
  }
  // Marks the customer as told; repeating it only moves the time.
  @Post("rounds/:id/notices") async notify(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: NoticeDto,
    @Req() req: AuthRequest,
  ) {
    await this.round(id);
    if (
      !(await this.db.customer.findUnique({ where: { id: body.customerId } }))
    )
      throw new NotFoundException("Cliente no encontrado.");
    const n = await this.db.customerNotice.upsert({
      where: {
        roundId_customerId: { roundId: id, customerId: body.customerId },
      },
      create: {
        roundId: id,
        customerId: body.customerId,
        actorId: req.actor.id,
      },
      update: { notifiedAt: new Date(), actorId: req.actor.id },
    });
    return { customerId: n.customerId, notifiedAt: n.notifiedAt };
  }
  @Delete("rounds/:id/notices/:customerId") async unnotify(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
  ) {
    await this.db.customerNotice.deleteMany({
      where: { roundId: id, customerId },
    });
    return { customerId, notifiedAt: null };
  }
}
