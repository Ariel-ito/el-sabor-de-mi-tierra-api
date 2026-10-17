-- CreateTable
CREATE TABLE "CustomerNotice" (
    "id" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "notifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerNotice_roundId_customerId_key" ON "CustomerNotice"("roundId", "customerId");

-- AddForeignKey
ALTER TABLE "CustomerNotice" ADD CONSTRAINT "CustomerNotice_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNotice" ADD CONSTRAINT "CustomerNotice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

