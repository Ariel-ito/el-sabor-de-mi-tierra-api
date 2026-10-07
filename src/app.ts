import { Module } from "@nestjs/common";
import { AccountsController } from "./accounts.controller";
import { AuthController } from "./auth.controller";
import { CatalogController } from "./catalog.controller";
import { AuthGuard, Db } from "./core";
import { FinanceController } from "./finance.controller";
import { HealthController } from "./health.controller";
import { InventoryController } from "./inventory.controller";
import { OrdersController } from "./orders.controller";
import { PurchasesController } from "./purchases.controller";
import { RoundsController } from "./rounds.controller";
import { SettingsController } from "./settings.controller";
import { SalesController } from "./sales.controller";
@Module({
  controllers: [
    HealthController,
    AuthController,
    CatalogController,
    RoundsController,
    OrdersController,
    InventoryController,
    PurchasesController,
    SalesController,
    FinanceController,
    AccountsController,
    SettingsController,
  ],
  providers: [Db, AuthGuard],
})
export class AppModule {}
