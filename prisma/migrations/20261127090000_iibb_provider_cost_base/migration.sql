-- IIBB: base por diferencia (criterio del estudio): prestadores del cliente y ajuste manual por período.
-- Aditiva: dos tablas nuevas. No modifica datos existentes.
CREATE TABLE "ClientIibbProvider" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "cuit" VARCHAR(11) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "activityCode" VARCHAR(12) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientIibbProvider_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClientIibbProvider_cuit_check" CHECK ("cuit" ~ '^[0-9]{11}$')
);
CREATE UNIQUE INDEX "ClientIibbProvider_clientId_cuit_key" ON "ClientIibbProvider"("clientId", "cuit");
CREATE INDEX "ClientIibbProvider_organizationId_idx" ON "ClientIibbProvider"("organizationId");
ALTER TABLE "ClientIibbProvider" ADD CONSTRAINT "ClientIibbProvider_clientId_organizationId_fkey"
    FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientIibbProvider" ENABLE ROW LEVEL SECURITY;

CREATE TABLE "PeriodIibbCostAdjustment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "activityCode" VARCHAR(12) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" VARCHAR(300) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PeriodIibbCostAdjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PeriodIibbCostAdjustment_note_check" CHECK (length(btrim("note")) > 0)
);
CREATE UNIQUE INDEX "PeriodIibbCostAdjustment_periodId_activityCode_key" ON "PeriodIibbCostAdjustment"("periodId", "activityCode");
CREATE INDEX "PeriodIibbCostAdjustment_organizationId_idx" ON "PeriodIibbCostAdjustment"("organizationId");
ALTER TABLE "PeriodIibbCostAdjustment" ADD CONSTRAINT "PeriodIibbCostAdjustment_periodId_organizationId_fkey"
    FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PeriodIibbCostAdjustment" ENABLE ROW LEVEL SECURITY;
