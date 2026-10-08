-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'PURCHASE';

-- AlterTable
ALTER TABLE "StockWithdrawal" ADD COLUMN     "assemblyId" UUID;

-- CreateTable
CREATE TABLE "ProductComponent" (
    "id" UUID NOT NULL,
    "comboId" UUID NOT NULL,
    "componentId" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,

    CONSTRAINT "ProductComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductComponent_comboId_componentId_key" ON "ProductComponent"("comboId", "componentId");

-- AddForeignKey
ALTER TABLE "ProductComponent" ADD CONSTRAINT "ProductComponent_comboId_fkey" FOREIGN KEY ("comboId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductComponent" ADD CONSTRAINT "ProductComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_kind_check" CHECK ("kind" IN ('PURCHASE', 'ASSEMBLY'));
ALTER TABLE "ProductComponent" ADD CONSTRAINT "ProductComponent_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "ProductComponent" ADD CONSTRAINT "ProductComponent_not_self" CHECK ("comboId" <> "componentId");
CREATE INDEX "StockWithdrawal_assemblyId_idx" ON "StockWithdrawal"("assemblyId");

-- Stock consumed to assemble combos is not a loss.
ALTER TABLE "StockWithdrawal" DROP CONSTRAINT "StockWithdrawal_valid_reason";
ALTER TABLE "StockWithdrawal" ADD CONSTRAINT "StockWithdrawal_valid_reason" CHECK ("reason" IN ('SAMPLE', 'PERSONAL', 'LOSS', 'ASSEMBLY'));
