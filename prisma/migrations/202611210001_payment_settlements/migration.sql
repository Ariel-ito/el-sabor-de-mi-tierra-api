ALTER TABLE "Payment"
  ADD COLUMN "receivedAmount" DECIMAL(12,2),
  ADD COLUMN "tipAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "changeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "excessDisposition" TEXT,
  ADD CONSTRAINT "Payment_settlement_nonnegative" CHECK ("tipAmount" >= 0 AND "changeAmount" >= 0 AND ("receivedAmount" IS NULL OR "receivedAmount" >= "amount" + "tipAmount" + "changeAmount")),
  ADD CONSTRAINT "Payment_settlement_disposition" CHECK (("excessDisposition" IS NULL OR "excessDisposition" IN ('TIP','CREDIT','CHANGE')) AND ("tipAmount" = 0 OR "excessDisposition" = 'TIP') AND ("changeAmount" = 0 OR "excessDisposition" = 'CHANGE'));
ALTER TABLE "CustomerPayment"
  ADD COLUMN "tipAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "changeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "excessDisposition" TEXT,
  ADD COLUMN "tipRoundId" UUID REFERENCES "Round"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidReason" TEXT,
  ADD CONSTRAINT "CustomerPayment_settlement_nonnegative" CHECK ("tipAmount" >= 0 AND "changeAmount" >= 0 AND "tipAmount" + "changeAmount" <= "amount"),
  ADD CONSTRAINT "CustomerPayment_settlement_disposition" CHECK (("excessDisposition" IS NULL OR "excessDisposition" IN ('TIP','CREDIT','CHANGE')) AND ("tipAmount" = 0 OR "excessDisposition" = 'TIP') AND ("changeAmount" = 0 OR "excessDisposition" = 'CHANGE'));
CREATE INDEX "CustomerPayment_tipRoundId_idx" ON "CustomerPayment"("tipRoundId");
INSERT INTO "FinanceCategory" ("id","name","kind","systemKey","inResult") VALUES (gen_random_uuid(),'Propinas','INCOME','TIPS',true) ON CONFLICT ("systemKey") DO NOTHING;
