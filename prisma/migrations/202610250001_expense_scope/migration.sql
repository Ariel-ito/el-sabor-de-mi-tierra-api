ALTER TABLE "FinanceCategory" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'BUSINESS';
ALTER TABLE "FinanceMovement" ADD COLUMN "spreadCycles" INTEGER NOT NULL DEFAULT 1;
UPDATE "FinanceCategory" SET "scope" = 'CYCLE' WHERE "kind" = 'EXPENSE' AND ("systemKey" = 'TRANSPORT' OR "name" = 'Empaque e insumos');
