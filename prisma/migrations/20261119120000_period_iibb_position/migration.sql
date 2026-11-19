-- Posición de IIBB del período (F.5680 y equivalentes): saldo a favor anterior,
-- pagos a cuenta, otros créditos/débitos y la DDJJ efectivamente presentada.
CREATE TABLE "PeriodIibbPosition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "previousBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paymentsOnAccount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherCredits" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otherDebits" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reference" VARCHAR(120),
    "filedVerifier" VARCHAR(20),
    "filedDate" DATE,
    "filedTaxAmount" DECIMAL(18,2),
    "filedDeductionsAmount" DECIMAL(18,2),
    "filedBalanceDgr" DECIMAL(18,2),
    "filedBalanceTaxpayer" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "updatedById" UUID,
    CONSTRAINT "PeriodIibbPosition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PeriodIibbPosition_amounts_check" CHECK (
        "previousBalance" >= 0 AND "paymentsOnAccount" >= 0 AND "otherCredits" >= 0 AND "otherDebits" >= 0
        AND ("filedTaxAmount" IS NULL OR "filedTaxAmount" >= 0)
        AND ("filedDeductionsAmount" IS NULL OR "filedDeductionsAmount" >= 0)
        AND ("filedBalanceDgr" IS NULL OR "filedBalanceDgr" >= 0)
        AND ("filedBalanceTaxpayer" IS NULL OR "filedBalanceTaxpayer" >= 0)
    )
);

CREATE UNIQUE INDEX "PeriodIibbPosition_periodId_key" ON "PeriodIibbPosition"("periodId");
CREATE UNIQUE INDEX "PeriodIibbPosition_periodId_organizationId_key" ON "PeriodIibbPosition"("periodId", "organizationId");
CREATE INDEX "PeriodIibbPosition_organizationId_idx" ON "PeriodIibbPosition"("organizationId");

ALTER TABLE "PeriodIibbPosition" ADD CONSTRAINT "PeriodIibbPosition_periodId_organizationId_fkey"
    FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Misma política que el resto de las tablas: RLS sin políticas (acceso sólo del backend).
ALTER TABLE "PeriodIibbPosition" ENABLE ROW LEVEL SECURITY;
