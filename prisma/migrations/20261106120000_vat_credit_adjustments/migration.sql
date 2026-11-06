-- Liquidación de IVA, etapa 2: ajustes al crédito fiscal por contribuciones a la
-- Seguridad Social (Portal IVA → Ajustes al Crédito Fiscal) y saldo técnico a
-- favor del período anterior (F.2051 → Determinación del impuesto).
--
-- ADITIVA: un tipo, dos columnas con default en PeriodVatSettings (sin
-- reescritura en PostgreSQL 11+) y una tabla nueva vacía. No toca filas
-- existentes. Fuentes:
--  - Ley 27.541 art. 21 y Anexo I (régimen general de empleadores).
--  - Ley 27.467 art. 91 (3er art. s/n a continuación del art. 24 de la ley de IVA):
--    radiodifusión, señales y editoras; antes que los demás créditos y hasta el
--    débito fiscal, sin generar saldo a favor.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
CREATE TYPE "VatCreditAdjustmentRegime" AS ENUM ('LEY_27541_ANEXO_I', 'LEY_27467_ART_91');

-- AlterTable
ALTER TABLE "PeriodVatSettings" ADD COLUMN     "previousTechnicalBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "previousTechnicalBalanceReference" VARCHAR(120);
ALTER TABLE "PeriodVatSettings" ADD CONSTRAINT "PeriodVatSettings_previousTechnicalBalance_check" CHECK ("previousTechnicalBalance" >= 0);

-- CreateTable
CREATE TABLE "PeriodVatCreditAdjustment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "regime" "VatCreditAdjustmentRegime" NOT NULL,
    "contributionsAmount" DECIMAL(18,2) NOT NULL,
    "computableAmount" DECIMAL(18,2) NOT NULL,
    "reference" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "PeriodVatCreditAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeriodVatCreditAdjustment_periodId_organizationId_idx" ON "PeriodVatCreditAdjustment"("periodId", "organizationId");

-- CreateIndex
CREATE INDEX "PeriodVatCreditAdjustment_organizationId_idx" ON "PeriodVatCreditAdjustment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodVatCreditAdjustment_periodId_regime_key" ON "PeriodVatCreditAdjustment"("periodId", "regime");

-- AddForeignKey
ALTER TABLE "PeriodVatCreditAdjustment" ADD CONSTRAINT "PeriodVatCreditAdjustment_periodId_organizationId_fkey" FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodVatCreditAdjustment" ADD CONSTRAINT "PeriodVatCreditAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodVatCreditAdjustment" ADD CONSTRAINT "PeriodVatCreditAdjustment_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 0 <= computable <= contribuciones efectivamente abonadas.
ALTER TABLE "PeriodVatCreditAdjustment" ADD CONSTRAINT "PeriodVatCreditAdjustment_amounts_check" CHECK ("contributionsAmount" >= 0 AND "computableAmount" >= 0 AND "computableAmount" <= "contributionsAmount");

-- Tabla nueva: sólo la usa el servidor (Prisma, rol propietario). RLS sin
-- políticas y sin privilegios para PUBLIC ni para los roles de la API de
-- Supabase (mismo criterio que 20261104120000_studio_users_permissions).
DO $tables$
DECLARE r TEXT;
BEGIN
 ALTER TABLE "PeriodVatCreditAdjustment" ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON TABLE "PeriodVatCreditAdjustment" FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE "PeriodVatCreditAdjustment" FROM %I', r);
 END LOOP;
END
$tables$;

COMMIT;
