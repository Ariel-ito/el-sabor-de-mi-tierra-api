ALTER TABLE "OrderItem" ADD COLUMN "totalAmount" DECIMAL(12,2);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_totalAmount_nonnegative" CHECK ("totalAmount" >= 0);
