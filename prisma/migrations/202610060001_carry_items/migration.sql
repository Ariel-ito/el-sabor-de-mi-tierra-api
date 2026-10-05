-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "fulfillRoundId" UUID;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_fulfillRoundId_fkey" FOREIGN KEY ("fulfillRoundId") REFERENCES "Round"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "OrderItem_fulfillRoundId_idx" ON "OrderItem"("fulfillRoundId");
