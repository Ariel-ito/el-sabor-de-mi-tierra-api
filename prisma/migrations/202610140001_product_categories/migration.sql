-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "categoryId" UUID;

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_name_key" ON "ProductCategory"("name");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;


CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- Starting lines of business; today's products are dairy.
INSERT INTO "ProductCategory" ("id", "name") VALUES
  (gen_random_uuid(), 'Lácteos'),
  (gen_random_uuid(), 'Panadería'),
  (gen_random_uuid(), 'Miel'),
  (gen_random_uuid(), 'Suplementos');
UPDATE "Product" SET "categoryId" = (SELECT "id" FROM "ProductCategory" WHERE "name" = 'Lácteos') WHERE "categoryId" IS NULL;
