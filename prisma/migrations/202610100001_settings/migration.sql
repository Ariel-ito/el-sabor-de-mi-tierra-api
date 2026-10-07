-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- Approved initial payment details (Oct 2026); editable in Cobranza.
INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (
  'paymentInfo',
  E'*Transferencia bancaria*\nBanco: BAC Credomatic\nTitular: ARIEL OBED MARTINEZ LOPEZ\nCuenta: 722210961\n\n*Efectivo*\nAl recibir su pedido.',
  CURRENT_TIMESTAMP
);
