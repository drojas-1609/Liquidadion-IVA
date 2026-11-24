-- IIBB F2: alícuotas por año fiscal e ingresos brutos anuales del cliente.
CREATE TABLE "ClientIibbRateYear" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "jurisdictionCode" VARCHAR(3) NOT NULL,
    "activityCode" VARCHAR(12) NOT NULL,
    "rate" DECIMAL(9,6),
    "treatment" "RateTreatment" NOT NULL DEFAULT 'RATE',
    "rateOrigin" "RateOrigin",
    "ruleRef" TEXT,
    "confirmedById" UUID,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientIibbRateYear_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClientIibbRateYear_year_check" CHECK ("fiscalYear" BETWEEN 2000 AND 2100),
    CONSTRAINT "ClientIibbRateYear_rate_check" CHECK (("treatment" = 'EXEMPT' AND "rate" IS NULL) OR ("treatment" = 'RATE' AND ("rate" IS NULL OR ("rate" >= 0 AND "rate" <= 100))))
);
CREATE UNIQUE INDEX "ClientIibbRateYear_clientId_fiscalYear_jurisdictionCode_activityCode_key" ON "ClientIibbRateYear"("clientId", "fiscalYear", "jurisdictionCode", "activityCode");
CREATE INDEX "ClientIibbRateYear_organizationId_idx" ON "ClientIibbRateYear"("organizationId");
ALTER TABLE "ClientIibbRateYear" ADD CONSTRAINT "ClientIibbRateYear_clientId_organizationId_fkey"
    FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientIibbRateYear" ENABLE ROW LEVEL SECURITY;

CREATE TABLE "ClientGrossIncomeYear" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "incomeYear" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" VARCHAR(300),
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientGrossIncomeYear_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClientGrossIncomeYear_year_check" CHECK ("incomeYear" BETWEEN 2000 AND 2100),
    CONSTRAINT "ClientGrossIncomeYear_amount_check" CHECK ("amount" >= 0)
);
CREATE UNIQUE INDEX "ClientGrossIncomeYear_clientId_incomeYear_key" ON "ClientGrossIncomeYear"("clientId", "incomeYear");
CREATE INDEX "ClientGrossIncomeYear_organizationId_idx" ON "ClientGrossIncomeYear"("organizationId");
ALTER TABLE "ClientGrossIncomeYear" ADD CONSTRAINT "ClientGrossIncomeYear_clientId_organizationId_fkey"
    FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientGrossIncomeYear" ENABLE ROW LEVEL SECURITY;

-- Las alícuotas informadas de la ficha pasan a ser las de 2026 (único año con períodos al 24/11/2026).
INSERT INTO "ClientIibbRateYear" ("id", "organizationId", "clientId", "fiscalYear", "jurisdictionCode", "activityCode", "rate", "treatment", "rateOrigin", "ruleRef", "confirmedAt", "updatedAt")
SELECT 'ry' || md5(r."id"), r."organizationId", r."clientId", 2026, r."jurisdictionCode", a."code", r."rate", r."treatment", r."rateOrigin", r."ruleRef", r."updatedAt", CURRENT_TIMESTAMP
FROM "ClientActivityRate" r
JOIN "ClientActivity" a ON a."id" = r."activityId"
WHERE (r."treatment" = 'EXEMPT' OR r."rate" IS NOT NULL)
ON CONFLICT DO NOTHING;
