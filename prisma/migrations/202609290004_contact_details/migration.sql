ALTER TABLE "Customer" ADD COLUMN "phoneCountryCode" TEXT NOT NULL DEFAULT '+504';
ALTER TABLE "Supplier" ADD COLUMN "phoneCountryCode" TEXT NOT NULL DEFAULT '+504', ADD COLUMN "deliveryContactName" TEXT, ADD COLUMN "deliveryContactPhone" TEXT, ADD COLUMN "deliveryContactCountryCode" TEXT NOT NULL DEFAULT '+504';
