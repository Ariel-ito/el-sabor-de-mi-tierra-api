-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "partialOk" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "packedAt" TIMESTAMP(3);

