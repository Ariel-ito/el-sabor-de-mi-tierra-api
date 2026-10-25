-- Packaging is what the app splits over cycles and warns about running out.
UPDATE "FinanceCategory" SET "systemKey" = 'PACKAGING', "scope" = 'CYCLE' WHERE "kind" = 'EXPENSE' AND "name" = 'Empaque e insumos' AND "systemKey" IS NULL;
INSERT INTO "FinanceCategory" ("id", "name", "kind", "systemKey", "inResult", "scope")
SELECT gen_random_uuid(), 'Empaque e insumos', 'EXPENSE', 'PACKAGING', true, 'CYCLE'
WHERE NOT EXISTS (SELECT 1 FROM "FinanceCategory" WHERE "systemKey" = 'PACKAGING');
