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
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import { LotExpiryDto, WithdrawalDto } from "./dto";
import { allocateStock, inventory, stockLock } from "./inventory";
import { decimal } from "./math";
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class InventoryController {
  constructor(@Inject(Db) private db: Db) {}
  @Get("inventory") async stock() {
    return this.db.$transaction(
      async (tx) => {
        await stockLock(tx);
        await allocateStock(tx);
        return inventory(tx);
      },
      { timeout: 15000 },
    );
  }
  // Correct a lot's expiry, e.g. when the real date is known later.
  @Patch("inventory/lots/:id/expiry") async setExpiry(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: LotExpiryDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await tx.receiptItem.findUnique({ where: { id } });
      if (!before) throw new NotFoundException("Lote no encontrado.");
      const after = await tx.receiptItem.update({
        where: { id },
        data: { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null },
      });
      await audit(tx, req.actor.id, "ReceiptItem", id, "EXPIRY", before, after);
      return { id, expiresAt: after.expiresAt };
    });
  }
  @Post("inventory/withdrawals") async withdraw(
    @Body() body: WithdrawalDto,
    @Req() req: AuthRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      await stockLock(tx);
      const prior = await tx.stockWithdrawal.findUnique({
        where: { id: body.id },
      });
      if (prior) {
        if (prior.receiptItemId !== body.receiptItemId)
          throw new ConflictException("Identificador ya utilizado");
        return prior;
      }
      await allocateStock(tx);
      const lot = (await inventory(tx)).find(
        (l) => l.id === body.receiptItemId,
      );
      if (!lot || decimal(lot.available).lt(body.quantity))
        throw new BadRequestException(
          "La salida supera las libras libres del lote.",
        );
      const result = await tx.stockWithdrawal.create({ data: body });
      await audit(
        tx,
        req.actor.id,
        "StockWithdrawal",
        body.id,
        "CREATE",
        null,
        result,
      );
      return result;
    });
  }
}
