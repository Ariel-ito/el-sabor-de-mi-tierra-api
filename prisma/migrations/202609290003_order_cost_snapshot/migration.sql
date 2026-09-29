ALTER TABLE "OrderItem" ADD COLUMN "estimatedUnitCost" DECIMAL(12,2);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_estimatedUnitCost_nonnegative" CHECK ("estimatedUnitCost" IS NULL OR "estimatedUnitCost" >= 0);
