ALTER TABLE "OrderItem" ADD COLUMN "packedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0;
-- Preserve existing ticks only for stock still reserved and undelivered.
UPDATE "OrderItem" i SET "packedQuantity" = LEAST(i.quantity, COALESCE((
 SELECT SUM(a.quantity - a.delivered) FROM "StockAllocation" a WHERE a."orderItemId" = i.id
), 0)) WHERE i."packedAt" IS NOT NULL;
UPDATE "OrderItem" SET "packedAt" = NULL WHERE "packedQuantity" = 0;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_packedQuantity_nonnegative" CHECK ("packedQuantity" >= 0);
CREATE INDEX "AuditLog_entityId_action_createdAt_idx" ON "AuditLog"("entityId", "action", "createdAt");
