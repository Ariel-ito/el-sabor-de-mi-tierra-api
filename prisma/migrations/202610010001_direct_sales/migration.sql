ALTER TABLE "Order" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ENCARGO';
ALTER TABLE "Order" ADD CONSTRAINT "Order_valid_kind" CHECK ("kind" IN ('ENCARGO','DIRECT'));
CREATE INDEX "Order_kind_createdAt_idx" ON "Order"("kind", "createdAt");
