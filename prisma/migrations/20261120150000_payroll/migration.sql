-- Fase C2c: módulo de Sueldos (F.931 con crédito Anexo I Ley 27.541 y boletas sindicales).
ALTER TABLE "Client" ADD COLUMN "payrollZoneCode" INTEGER;
ALTER TABLE "Client" ADD CONSTRAINT "Client_payrollZoneCode_check" CHECK ("payrollZoneCode" IS NULL OR ("payrollZoneCode" BETWEEN 1 AND 85));

CREATE TABLE "PayrollF931" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "zoneCode" INTEGER NOT NULL,
    "annexIPercent" DECIMAL(5,2) NOT NULL,
    "contributionsBase" DECIMAL(18,2) NOT NULL,
    "employerContributions" DECIMAL(18,2) NOT NULL,
    "creditAmount" DECIMAL(18,2) NOT NULL,
    "reference" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "updatedById" UUID,
    CONSTRAINT "PayrollF931_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayrollF931_amounts_check" CHECK ("contributionsBase" >= 0 AND "employerContributions" >= 0 AND "creditAmount" >= 0 AND "annexIPercent" >= 0 AND "annexIPercent" < 100 AND "zoneCode" BETWEEN 1 AND 85)
);
CREATE UNIQUE INDEX "PayrollF931_periodId_key" ON "PayrollF931"("periodId");
CREATE UNIQUE INDEX "PayrollF931_periodId_organizationId_key" ON "PayrollF931"("periodId", "organizationId");
CREATE INDEX "PayrollF931_clientId_organizationId_idx" ON "PayrollF931"("clientId", "organizationId");
ALTER TABLE "PayrollF931" ADD CONSTRAINT "PayrollF931_periodId_organizationId_fkey"
    FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PayrollUnionSlip" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "union" VARCHAR(80) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidDate" DATE,
    "paymentAccountId" TEXT,
    "accrualEntryId" TEXT,
    "paymentEntryId" TEXT,
    "reference" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    CONSTRAINT "PayrollUnionSlip_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayrollUnionSlip_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "PayrollUnionSlip_payment_check" CHECK (("paidDate" IS NULL) = ("paymentAccountId" IS NULL))
);
CREATE INDEX "PayrollUnionSlip_clientId_organizationId_idx" ON "PayrollUnionSlip"("clientId", "organizationId");
CREATE INDEX "PayrollUnionSlip_periodId_idx" ON "PayrollUnionSlip"("periodId");
ALTER TABLE "PayrollUnionSlip" ADD CONSTRAINT "PayrollUnionSlip_periodId_organizationId_fkey"
    FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_kind_check";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_kind_check" CHECK ("kind" IN ('VAT_POSITION', 'IIBB_POSITION', 'TAX_PAYMENT', 'PAYROLL_F931', 'UNION_SLIP', 'UNION_PAYMENT'));

ALTER TABLE "PayrollF931" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayrollUnionSlip" ENABLE ROW LEVEL SECURITY;
