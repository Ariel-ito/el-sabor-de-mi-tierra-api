import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { audit, AuthGuard, AuthRequest, Db } from "./core";
import { WithdrawalDto } from "./dto";
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
