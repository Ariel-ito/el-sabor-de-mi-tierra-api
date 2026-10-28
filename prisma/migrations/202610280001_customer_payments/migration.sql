CREATE TABLE "CustomerPayment" (
  "id" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "method" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerPayment_positive_amount" CHECK ("amount" > 0),
  CONSTRAINT "CustomerPayment_method" CHECK ("method" IN ('CASH', 'TRANSFER'))
);
ALTER TABLE "Payment" ADD COLUMN "customerPaymentId" UUID;
ALTER TABLE "CustomerCredit" ADD COLUMN "customerPaymentId" UUID;
CREATE INDEX "CustomerPayment_customerId_paidAt_idx" ON "CustomerPayment"("customerId", "paidAt");
CREATE INDEX "Payment_customerPaymentId_idx" ON "Payment"("customerPaymentId");
CREATE UNIQUE INDEX "CustomerCredit_customerPaymentId_key" ON "CustomerCredit"("customerPaymentId");
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerPaymentId_fkey" FOREIGN KEY ("customerPaymentId") REFERENCES "CustomerPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_customerPaymentId_fkey" FOREIGN KEY ("customerPaymentId") REFERENCES "CustomerPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
