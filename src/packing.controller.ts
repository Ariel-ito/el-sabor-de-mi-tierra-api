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
import { ApiBearerAuth } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { AuthGuard, AuthRequest, Db } from "./core";
import { PackingDto, PackingQuantitiesDto } from "./dto";
import { allocateStock, stockLock } from "./inventory";
import { decimal, orderInclude, serializeOrder } from "./math";
import { assertQuantity } from "./units";

@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class PackingController {
  constructor(@Inject(Db) private db: Db) {}

  @Get("orders/:id/packing") async history(
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    if (
      !(await this.db.order.findUnique({ where: { id }, select: { id: true } }))
    )
      throw new NotFoundException("Encargo no encontrado.");
    const rows = await this.db.auditLog.findMany({
      where: { entityType: "Order", entityId: id, action: "PACKING" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 30,
    });
    const actors = await this.db.user.findMany({
      where: { id: { in: rows.map((r) => r.actorId) } },
      select: { id: true, name: true },
    });
    return rows.map((r) => ({
      id: r.id,
      at: r.createdAt,
      actor: actors.find((a) => a.id === r.actorId)?.name ?? "Administración",
      ...(r.after as Record<string, unknown>),
      request: undefined,
    }));
  }

  @Post("orders/:id/packing/quantities") pack(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: PackingQuantitiesDto,
    @Req() req: AuthRequest,
  ) {
    return this.save(id, body, req);
  }

  // Keep older deployed web clients working during independent API rollouts.
  @Post("orders/:id/packing") legacy(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: PackingDto,
    @Req() req: AuthRequest,
  ) {
    return this.save(id, body, req);
  }

  private save(
    id: string,
    body: PackingQuantitiesDto | PackingDto,
    req: AuthRequest,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        const modern = "version" in body;
        const fingerprint = modern
          ? JSON.stringify({
              version: body.version,
              mode: body.mode,
              items: body.items
                .map((i) => ({
                  orderItemId: i.orderItemId,
                  quantity: decimal(i.quantity).toString(),
                }))
                .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)),
            })
          : "";
        if (modern) {
          const prior = await tx.auditLog.findUnique({
            where: { id: body.id },
          });
          if (prior) {
            if (
              prior.entityId !== id ||
              prior.action !== "PACKING" ||
              (prior.after as Record<string, unknown>).request !== fingerprint
            )
              throw new ConflictException(
                "Identificador ya utilizado para otro empaque.",
              );
            return serializeOrder(
              await tx.order.findUniqueOrThrow({
                where: { id },
                include: orderInclude,
              }),
            );
          }
        }
        await allocateStock(tx);
        const order = await tx.order.findUnique({
          where: { id },
          include: orderInclude,
        });
        if (!order || order.cancelledAt)
          throw new NotFoundException("Encargo no encontrado.");
        if (modern && order.version !== body.version)
          throw new ConflictException(
            "El encargo o su empaque cambió. Actualiza las cantidades antes de confirmar.",
          );
        const items = modern
          ? body.items
          : body.items.map((orderItemId) => {
              const item = order.items.find((i) => i.id === orderItemId);
              return {
                orderItemId,
                quantity:
                  body.packed && item
                    ? item.allocations
                        .reduce(
                          (s, a) => s.add(a.quantity).sub(a.delivered),
                          decimal(0),
                        )
                        .toString()
                    : "0",
              };
            });
        if (new Set(items.map((i) => i.orderItemId)).size !== items.length)
          throw new BadRequestException("Producto repetido.");
        const mode = modern ? body.mode : body.packed ? "PACK" : "REVERT";
        const changes = [];
        for (const input of items) {
          const item = order.items.find((i) => i.id === input.orderItemId);
          if (!item)
            throw new BadRequestException("Producto ajeno al encargo.");
          const packed = decimal(input.quantity);
          assertQuantity(item.product.unit, packed, item.product.name);
          const available = item.allocations.reduce(
            (s, a) => s.add(a.quantity).sub(a.delivered),
            decimal(0),
          );
          const delivered = item.allocations.reduce(
            (s, a) => s.add(a.delivered),
            decimal(0),
          );
          if (packed.gt(available) || packed.gt(item.quantity.sub(delivered)))
            throw new BadRequestException(
              `${item.product.name}: no puedes empacar más de lo disponible y pendiente de entregar.`,
            );
          if (mode === "REVERT" && !packed.isZero())
            throw new BadRequestException(
              "Revertir el empaque deja las cantidades en cero.",
            );
          if (mode === "PACK" && packed.lt(item.packedQuantity))
            throw new BadRequestException(
              "Usa Editar empaque para reducir una cantidad ya empacada.",
            );
          if (packed.eq(item.packedQuantity)) continue;
          changes.push({
            orderItemId: item.id,
            product: item.product.name,
            supplier: item.supplier.name,
            unit: item.product.unit,
            before: item.packedQuantity.toString(),
            after: packed.toString(),
          });
          await tx.orderItem.update({
            where: { id: item.id },
            data: {
              packedQuantity: packed,
              packedAt: packed.gt(0) ? new Date() : null,
            },
          });
        }
        if (changes.length) {
          await tx.order.update({
            where: { id },
            data: { version: { increment: 1 } },
          });
          await tx.auditLog.create({
            data: {
              id: modern ? body.id : randomUUID(),
              actorId: req.actor.id,
              entityType: "Order",
              entityId: id,
              action: "PACKING",
              before: { version: order.version },
              after: { mode, changes, request: fingerprint },
            },
          });
        }
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
