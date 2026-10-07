-- AlterTable
ALTER TABLE "Order" ADD COLUMN "delivery" TEXT NOT NULL DEFAULT 'PICKUP',
ADD COLUMN "shippingFee" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "Order" ADD CONSTRAINT "Order_delivery_check" CHECK ("delivery" IN ('PICKUP', 'DELIVERY'));
ALTER TABLE "Order" ADD CONSTRAINT "Order_shippingFee_check" CHECK ("shippingFee" >= 0 AND ("delivery" = 'DELIVERY' OR "shippingFee" = 0));

-- Fuel is compared with shipping charged per cycle.
UPDATE "FinanceCategory" SET "systemKey" = 'TRANSPORT' WHERE "kind" = 'EXPENSE' AND "name" = 'Transporte y combustible' AND "systemKey" IS NULL;
