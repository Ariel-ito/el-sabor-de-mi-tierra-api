-- AlterTable
ALTER TABLE "Product" ADD COLUMN "shelfLifeDays" INTEGER,
ADD COLUMN "warnDays" INTEGER;

-- AlterTable
ALTER TABLE "ReceiptItem" ADD COLUMN "expiresAt" TIMESTAMP(3);

ALTER TABLE "Product" ADD CONSTRAINT "Product_shelfLifeDays_check" CHECK ("shelfLifeDays" IS NULL OR "shelfLifeDays" BETWEEN 1 AND 3650);
ALTER TABLE "Product" ADD CONSTRAINT "Product_warnDays_check" CHECK ("warnDays" IS NULL OR "warnDays" BETWEEN 0 AND 365);
