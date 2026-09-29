import { ApiBearerAuth } from "@nestjs/swagger";
import {
  BadRequestException,
  Body,
  CanActivate,
  Catch,
  ConflictException,
  Controller,
  ExecutionContext,
  ExceptionFilter,
  Get,
  HttpException,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import type { Request } from "express";
import {
  CustomerDto,
  LoginDto,
  OrderDto,
  OrderPatchDto,
  ProductDto,
  ProductPatchDto,
  RoundDto,
  RoundPatchDto,
  SupplierDto,
} from "./dto";
import {
  orderInclude,
  purchaseSummary,
  serializeOrder,
  money,
  statistics,
} from "./math";
import { hashPassword, hashToken, newToken, verifyPassword } from "./security";
@Injectable()
export class Db extends PrismaClient {}
export type AuthRequest = Request & {
  actor: { id: string; name: string; email: string };
  tokenHash: string;
};
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Db) private db: Db) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    )?.[1];
    if (!token) throw new UnauthorizedException("Sesión requerida");
    const tokenHash = hashToken(token);
    const session = await this.db.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!session || session.expiresAt <= new Date())
      throw new UnauthorizedException("Sesión vencida");
    req.actor = {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    };
    req.tokenHash = tokenHash;
    return true;
  }
}
@Catch()
export class Errors implements ExceptionFilter {
  catch(error: any, host: any) {
    const res = host.switchToHttp().getResponse();
    if (error?.type === "entity.parse.failed")
      return res
        .status(400)
        .json({ statusCode: 400, message: "JSON inválido" });
    if (error?.type === "entity.too.large")
      return res
        .status(413)
        .json({ statusCode: 413, message: "Solicitud demasiado grande" });
    if (error instanceof HttpException) {
      return res
        .status(error.getStatus())
        .json(
          typeof error.getResponse() === "string"
            ? { statusCode: error.getStatus(), message: error.message }
            : error.getResponse(),
        );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const status =
        error.code === "P2025" ? 404 : error.code === "P2003" ? 400 : 409;
      return res.status(status).json({
        statusCode: status,
        message:
          status === 404
            ? "Registro no encontrado"
            : status === 400
              ? "Referencia a un registro inexistente"
              : "Conflicto al guardar; actualiza y vuelve a intentar",
      });
    }
    console.error("Request failed", error?.name);
    res
      .status(500)
      .json({ statusCode: 500, message: "Error interno del servidor" });
  }
}
@Controller("health")
class HealthController {
  constructor(@Inject(Db) private db: Db) {}
  @Get() health() {
    return { status: "ok" };
  }
  @Get("ready") async ready() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return { status: "ok" };
    } catch {
      throw new ServiceUnavailableException("Base de datos no disponible");
    }
  }
}
@Controller("auth")
class AuthController {
  private attempts = new Map<string, { count: number; until: number }>();
  private dummy = hashPassword("not-a-real-user-password");
  constructor(@Inject(Db) private db: Db) {}
  @Post("login") async login(@Body() input: LoginDto, @Req() req: Request) {
    const now = Date.now();
    for (const [k, v] of this.attempts)
      if (v.until < now) this.attempts.delete(k);
    const keys = [`ip:${req.ip}`, `email:${input.email.toLowerCase().trim()}`];
    for (const key of keys) {
      const a = this.attempts.get(key) || {
        count: 0,
        until: now + 15 * 60 * 1000,
      };
      if (a.count >= 10)
        throw new HttpException("Demasiados intentos; espera 15 minutos", 429);
      a.count++;
      this.attempts.set(key, a);
    }
    const user = await this.db.user.findUnique({
      where: { email: input.email.toLowerCase().trim() },
    });
    const valid = await verifyPassword(
      input.password,
      user?.passwordHash || (await this.dummy),
    );
    if (!user || !valid)
      throw new UnauthorizedException("Correo o contraseña incorrectos");
    const accessToken = newToken(),
      expiresAt = new Date(now + 8 * 60 * 60 * 1000);
    await this.db.session.create({
      data: { userId: user.id, tokenHash: hashToken(accessToken), expiresAt },
    });
    return {
      accessToken,
      expiresAt,
      user: { id: user.id, name: user.name, email: user.email },
    };
  }
  @Get("me") @UseGuards(AuthGuard) me(@Req() req: AuthRequest) {
    return req.actor;
  }
  @Post("logout") @UseGuards(AuthGuard) async logout(@Req() req: AuthRequest) {
    await this.db.session.deleteMany({ where: { tokenHash: req.tokenHash } });
    return { ok: true };
  }
}
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
class BusinessController {
  constructor(@Inject(Db) private db: Db) {}
  private async audit(
    tx: Prisma.TransactionClient,
    actorId: string,
    entityType: string,
    entityId: string,
    action: string,
    before: any,
    after: any,
  ) {
    await tx.auditLog.create({
      data: {
        actorId,
        entityType,
        entityId,
        action,
        before: before ? JSON.parse(JSON.stringify(before)) : Prisma.JsonNull,
        after: JSON.parse(JSON.stringify(after)),
      },
    });
  }
  @Get("customers") customers() {
    return this.db.customer.findMany({ orderBy: { name: "asc" } });
  }
  @Post("customers") createCustomer(@Body() body: CustomerDto) {
    return this.db.customer.create({ data: body });
  }
  @Get("suppliers") suppliers() {
    return this.db.supplier.findMany({ orderBy: { name: "asc" } });
  }
  @Post("suppliers") createSupplier(@Body() body: SupplierDto) {
    return this.db.supplier.create({ data: body });
  }
  private product(p: any) {
    return {
      ...p,
      salePrice: money(p.salePrice),
      estimatedCost: money(p.estimatedCost),
    };
  }
  @Get("products") async products() {
    return (
      await this.db.product.findMany({
        include: { defaultSupplier: true },
        orderBy: { name: "asc" },
      })
    ).map((p) => this.product(p));
  }
  @Post("products") async createProduct(@Body() body: ProductDto) {
    return this.product(
      await this.db.product.create({
        data: body,
        include: { defaultSupplier: true },
      }),
    );
  }
  @Patch("products/:id") async patchProduct(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: ProductPatchDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Product" WHERE id=${id}::uuid FOR UPDATE`;
      const before = await tx.product.findUniqueOrThrow({ where: { id } });
      const after = await tx.product.update({
        where: { id },
        data: body,
        include: { defaultSupplier: true },
      });
      await this.audit(
        tx,
        req.actor.id,
        "Product",
        id,
        "UPDATE",
        before,
        after,
      );
      return this.product(after);
    });
  }
  @Get("rounds") rounds() {
    return this.db.round.findMany({ orderBy: { createdAt: "desc" } });
  }
  @Post("rounds") createRound(@Body() body: RoundDto) {
    if (new Date(body.closesAt) <= new Date(body.opensAt))
      throw new BadRequestException(
        "El cierre debe ser posterior a la apertura",
      );
    return this.db.round.create({ data: body });
  }
  private async lockRound(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM "Round" WHERE id=${id}::uuid FOR UPDATE`;
    const round = await tx.round.findUnique({ where: { id } });
    if (!round) throw new NotFoundException("Ciclo no encontrado");
    return round;
  }
  @Patch("rounds/:id") patchRound(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RoundPatchDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await this.lockRound(tx, id);
      if (
        new Date(body.closesAt ?? before.closesAt) <=
        new Date(body.opensAt ?? before.opensAt)
      )
        throw new BadRequestException(
          "El cierre debe ser posterior a la apertura",
        );
      const after = await tx.round.update({ where: { id }, data: body });
      await this.audit(tx, req.actor.id, "Round", id, "UPDATE", before, after);
      return after;
    });
  }
  @Get("orders") async orders(
    @Query("roundId", new ParseUUIDPipe({ optional: true })) roundId?: string,
  ) {
    return (
      await this.db.order.findMany({
        where: roundId ? { roundId } : {},
        include: orderInclude,
        orderBy: { createdAt: "desc" },
      })
    ).map(serializeOrder);
  }
  @Post("orders") createOrder(@Body() body: OrderDto, @Req() req: AuthRequest) {
    return this.db.$transaction(async (tx) => {
      const round = await this.lockRound(tx, body.roundId);
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
          items: { create: items },
        },
        include: orderInclude,
      });
      await this.audit(
        tx,
        req.actor.id,
        "Order",
        after.id,
        "CREATE",
        null,
        after,
      );
      return serializeOrder(after);
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
    }[],
    previous: any[] = [],
  ) {
    const ids = [...new Set(items.map((i) => i.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: ids }, active: true },
    });
    if (products.length !== ids.length)
      throw new BadRequestException("Producto inexistente o inactivo");
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
      const current = await tx.order.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("Pedido no encontrado");
      const round = await this.lockRound(tx, current.roundId);
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
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException(
          "El pedido cambió; recarga antes de editar",
        );
      if (body.items) {
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.orderItem.createMany({
          data: items!.map((item) => ({ ...item, orderId: id })),
        });
      }
      const after = await tx.order.findUniqueOrThrow({
        where: { id },
        include: orderInclude,
      });
      await this.audit(tx, req.actor.id, "Order", id, "UPDATE", before, after);
      return serializeOrder(after);
    });
  }
  @Get("statistics") async stats() {
    const [rounds, orders] = await this.db.$transaction([
      this.db.round.findMany({ orderBy: { opensAt: "desc" } }),
      this.db.order.findMany({ include: orderInclude }),
    ]);
    return statistics(rounds, orders);
  }
  @Get("rounds/:id/purchase-summary") async summary(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    await this.db.round.findUniqueOrThrow({ where: { id } });
    return purchaseSummary(
      id,
      await this.db.order.findMany({
        where: { roundId: id },
        include: orderInclude,
      }),
    );
  }
}
@Module({
  controllers: [HealthController, AuthController, BusinessController],
  providers: [Db, AuthGuard],
})
export class AppModule {}
