import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { CatalogController } from "./catalog.controller";
import { AuthGuard, Db } from "./core";
import { HealthController } from "./health.controller";
import { InventoryController } from "./inventory.controller";
import { OrdersController } from "./orders.controller";
import { PurchasesController } from "./purchases.controller";
import { RoundsController } from "./rounds.controller";
@Module({
  controllers: [
    HealthController,
    AuthController,
    CatalogController,
    RoundsController,
    OrdersController,
    InventoryController,
    PurchasesController,
  ],
  providers: [Db, AuthGuard],
})
export class AppModule {}
