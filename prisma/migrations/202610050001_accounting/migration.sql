-- CreateTable
CREATE TABLE "FinanceCategory" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "systemKey" TEXT,
    "inResult" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceMovement" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PAID',
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "categoryId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "method" TEXT,
    "paidBy" TEXT NOT NULL DEFAULT 'BUSINESS',
    "personalMode" TEXT,
    "reimbursedAt" TIMESTAMP(3),
    "owner" TEXT,
    "groupId" UUID,
    "roundId" UUID,
    "recurringId" UUID,
    "periodKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringExpense" (
    "id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "categoryId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "frequency" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "startsOn" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinanceCategory_systemKey_key" ON "FinanceCategory"("systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceCategory_kind_name_key" ON "FinanceCategory"("kind", "name");

-- CreateIndex
CREATE INDEX "FinanceMovement_date_idx" ON "FinanceMovement"("date");

-- CreateIndex
CREATE INDEX "FinanceMovement_roundId_idx" ON "FinanceMovement"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceMovement_recurringId_periodKey_key" ON "FinanceMovement"("recurringId", "periodKey");

-- AddForeignKey
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FinanceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_recurringId_fkey" FOREIGN KEY ("recurringId") REFERENCES "RecurringExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FinanceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity rules for accounting values.
ALTER TABLE "FinanceCategory" ADD CONSTRAINT "FinanceCategory_valid_kind" CHECK ("kind" IN ('INCOME','EXPENSE'));
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_valid_kind" CHECK ("kind" IN ('INCOME','EXPENSE'));
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_valid_status" CHECK ("status" IN ('PAID','PENDING','SKIPPED'));
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_positive_amount" CHECK ("amount" > 0);
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_valid_method" CHECK ("method" IS NULL OR "method" IN ('CASH','TRANSFER'));
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_valid_payer" CHECK ("paidBy" IN ('BUSINESS','ARIEL','MARIA'));
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_valid_personal_mode" CHECK ("personalMode" IS NULL OR "personalMode" IN ('REIMBURSE','CONTRIBUTE'));
ALTER TABLE "FinanceMovement" ADD CONSTRAINT "FinanceMovement_valid_owner" CHECK ("owner" IS NULL OR "owner" IN ('ARIEL','MARIA'));
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_positive_amount" CHECK ("amount" > 0);
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_valid_frequency" CHECK ("frequency" IN ('WEEKLY','BIWEEKLY','MONTHLY'));
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_valid_day" CHECK (("frequency" = 'MONTHLY' AND "day" BETWEEN 1 AND 28) OR ("frequency" <> 'MONTHLY' AND "day" BETWEEN 0 AND 6));

-- Agreed starting categories. System ones back automatic movements.
INSERT INTO "FinanceCategory" ("id","name","kind","systemKey","inResult") VALUES
  (gen_random_uuid(),'Compra de producto','EXPENSE','PRODUCT_PURCHASE',true),
  (gen_random_uuid(),'Transporte y combustible','EXPENSE',NULL,true),
  (gen_random_uuid(),'Empaque e insumos','EXPENSE',NULL,true),
  (gen_random_uuid(),'Equipo','EXPENSE',NULL,true),
  (gen_random_uuid(),'Publicidad','EXPENSE',NULL,true),
  (gen_random_uuid(),'Servicios','EXPENSE',NULL,true),
  (gen_random_uuid(),'Comisiones bancarias','EXPENSE',NULL,true),
  (gen_random_uuid(),'Búsqueda de proveedores e inicio','EXPENSE',NULL,true),
  (gen_random_uuid(),'Otros gastos','EXPENSE',NULL,true),
  (gen_random_uuid(),'Reparto de ganancias','EXPENSE','PROFIT_DISTRIBUTION',false),
  (gen_random_uuid(),'Venta','INCOME','SALE',true),
  (gen_random_uuid(),'Aporte de dueños','INCOME','OWNER_CONTRIBUTION',false),
  (gen_random_uuid(),'Préstamo','INCOME',NULL,false),
  (gen_random_uuid(),'Otros ingresos','INCOME',NULL,true);
