-- CreateTable
CREATE TABLE "CustomerCredit" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "orderId" UUID,
    "paymentId" UUID,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCredit_paymentId_key" ON "CustomerCredit"("paymentId");

-- CreateIndex
CREATE INDEX "CustomerCredit_customerId_idx" ON "CustomerCredit"("customerId");

-- CreateIndex
CREATE INDEX "CustomerCredit_orderId_idx" ON "CustomerCredit"("orderId");

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_kind_check" CHECK ("kind" IN ('DEPOSIT', 'OVERPAY', 'APPLY', 'REFUND'));
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_amount_check" CHECK ("amount" > 0);
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_method_check" CHECK ("method" IS NULL OR "method" IN ('CASH', 'TRANSFER'));

-- Payments taken from a customer's account.
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_valid_method";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_valid_method" CHECK ("method" IN ('CASH', 'TRANSFER', 'CREDIT'));
