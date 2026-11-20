-- IIBB F1: base imponible por actividad (actividad principal, punto de venta por actividad y corrección por comprobante).
ALTER TABLE "Client" ADD COLUMN "iibbPrincipalActivityCode" VARCHAR(12);
ALTER TABLE "Invoice" ADD COLUMN "iibbActivityCode" VARCHAR(12);

CREATE TABLE "ClientPosActivity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "pointOfSale" INTEGER NOT NULL,
    "activityCode" VARCHAR(12) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientPosActivity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClientPosActivity_pos_check" CHECK ("pointOfSale" BETWEEN 1 AND 99999)
);
CREATE UNIQUE INDEX "ClientPosActivity_clientId_pointOfSale_key" ON "ClientPosActivity"("clientId", "pointOfSale");
CREATE INDEX "ClientPosActivity_organizationId_idx" ON "ClientPosActivity"("organizationId");
ALTER TABLE "ClientPosActivity" ADD CONSTRAINT "ClientPosActivity_clientId_organizationId_fkey"
    FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientPosActivity" ENABLE ROW LEVEL SECURITY;
