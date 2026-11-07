-- Liquidación de IVA, etapa 3: clasificaciones para la presentación, detalle
-- de retenciones y percepciones del F.2051, saldo de libre disponibilidad
-- anterior y versiones cerradas de la liquidación.
--
-- ADITIVA: cuatro tipos nuevos, columnas NULLABLE (o con default constante,
-- sin reescritura en PostgreSQL 11+) y una tabla nueva vacía. No modifica
-- filas existentes: los comprobantes y retenciones quedan SIN CLASIFICAR
-- (NULL), sin valores inferidos. Fuentes (consultadas el 06/11/2026):
--  - IVA Simple – Especificación de Importaciones Apertura de otros conceptos
--    (https://www.arca.gob.ar/iva/documentos/LID-Ajustes-y-otros-conceptos-para-generar-la-DJ.pdf).
--  - F.2051 – Especificación de importaciones de retenciones y percepciones
--    (https://www.arca.gob.ar/iva/documentos/F2051-IVA-especificacion-de-importaciones.pdf, 12/11/2025).
--
-- Código publicado anterior: no lee ni escribe estas columnas (Prisma
-- selecciona columnas explícitas) y los defaults cubren sus INSERT.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
CREATE TYPE "SaleOperationType" AS ENUM ('GOODS_SERVICES', 'CAPITAL_GOODS');

-- CreateEnum
CREATE TYPE "BuyerType" AS ENUM ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO');

-- CreateEnum
CREATE TYPE "PurchaseCreditConcept" AS ENUM ('GOODS', 'LEASES', 'SERVICES', 'CAPITAL_GOODS');

-- CreateEnum
CREATE TYPE "TaxRecordNature" AS ENUM ('RETENTION', 'PERCEPTION', 'CUSTOMS_PERCEPTION');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "activityCode" VARCHAR(6),
ADD COLUMN     "buyerType" "BuyerType",
ADD COLUMN     "dationInPayment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "purchaseCreditConcept" "PurchaseCreditConcept",
ADD COLUMN     "saleOperationType" "SaleOperationType";

-- Las clasificaciones de ventas sólo en ventas; la de compras sólo en compras.
-- NOT VALID + VALIDATE: no bloquea escrituras mientras se verifica (todas las
-- filas existentes tienen NULL / false y cumplen).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_export_classification_check" CHECK (
    ("category" = 'SALES' AND "purchaseCreditConcept" IS NULL)
    OR ("category" = 'PURCHASES' AND "activityCode" IS NULL AND "saleOperationType" IS NULL AND "buyerType" IS NULL AND "dationInPayment" = false)
    OR ("category" NOT IN ('SALES', 'PURCHASES') AND "activityCode" IS NULL AND "saleOperationType" IS NULL AND "buyerType" IS NULL AND "purchaseCreditConcept" IS NULL AND "dationInPayment" = false)
) NOT VALID;
ALTER TABLE "Invoice" VALIDATE CONSTRAINT "Invoice_export_classification_check";
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_activityCode_check" CHECK ("activityCode" IS NULL OR "activityCode" ~ '^[0-9]{6}$') NOT VALID;
ALTER TABLE "Invoice" VALIDATE CONSTRAINT "Invoice_activityCode_check";

-- AlterTable
ALTER TABLE "PeriodVatSettings" ADD COLUMN     "previousFreeBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "previousFreeBalanceReference" VARCHAR(120);
ALTER TABLE "PeriodVatSettings" ADD CONSTRAINT "PeriodVatSettings_previousFreeBalance_check" CHECK ("previousFreeBalance" >= 0);

-- AlterTable
ALTER TABLE "TaxRecord" ADD COLUMN     "agentCuit" VARCHAR(11),
ADD COLUMN     "certificateNumber" VARCHAR(40),
ADD COLUMN     "customsDocument" VARCHAR(24),
ADD COLUMN     "intermediaryCuit" VARCHAR(11),
ADD COLUMN     "invoiceId" TEXT,
ADD COLUMN     "nature" "TaxRecordNature",
ADD COLUMN     "regimeCode" INTEGER,
ADD COLUMN     "taxCode" INTEGER,
ADD COLUMN     "voucherNumber" VARCHAR(20),
ADD COLUMN     "voucherTypeCode" INTEGER;

-- Formato técnico del detalle (la validación completa está en la aplicación).
ALTER TABLE "TaxRecord" ADD CONSTRAINT "TaxRecord_f2051_detail_check" CHECK (
    ("agentCuit" IS NULL OR "agentCuit" ~ '^[0-9]{11}$')
    AND ("intermediaryCuit" IS NULL OR "intermediaryCuit" ~ '^[0-9]{11}$')
    AND ("regimeCode" IS NULL OR "regimeCode" > 0)
    AND ("taxCode" IS NULL OR "taxCode" IN (767, 216))
    AND ("nature" IS NULL OR "type" IN ('RETENCION IVA', 'PERCEPCION IVA'))
    AND ("nature" IS DISTINCT FROM 'RETENTION' OR "type" = 'RETENCION IVA')
    AND ("nature" IS NULL OR "nature" = 'RETENTION' OR "type" = 'PERCEPCION IVA')
    AND ("invoiceId" IS NULL OR "nature" = 'PERCEPTION')
) NOT VALID;
ALTER TABLE "TaxRecord" VALIDATE CONSTRAINT "TaxRecord_f2051_detail_check";

-- Sin duplicados: una percepción por comprobante de compra; un certificado de
-- retención por agente; una percepción por agente, régimen y comprobante; una
-- percepción aduanera por régimen y despacho. Dentro del período.
CREATE UNIQUE INDEX "TaxRecord_invoice_key" ON "TaxRecord"("invoiceId") WHERE "invoiceId" IS NOT NULL;
CREATE UNIQUE INDEX "TaxRecord_retention_certificate_key" ON "TaxRecord"("periodId", "agentCuit", "certificateNumber")
    WHERE "nature" = 'RETENTION' AND "agentCuit" IS NOT NULL AND "certificateNumber" IS NOT NULL;
CREATE UNIQUE INDEX "TaxRecord_perception_voucher_key" ON "TaxRecord"("periodId", "regimeCode", "agentCuit", "voucherTypeCode", "voucherNumber")
    WHERE "nature" = 'PERCEPTION' AND "regimeCode" IS NOT NULL AND "agentCuit" IS NOT NULL AND "voucherTypeCode" IS NOT NULL AND "voucherNumber" IS NOT NULL;
CREATE UNIQUE INDEX "TaxRecord_customs_perception_key" ON "TaxRecord"("periodId", "regimeCode", "customsDocument")
    WHERE "nature" = 'CUSTOMS_PERCEPTION' AND "regimeCode" IS NOT NULL AND "customsDocument" IS NOT NULL;

-- CreateTable
CREATE TABLE "PeriodLiquidationVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "closedById" UUID,
    "engineVersion" VARCHAR(32) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "summary" JSONB NOT NULL,
    "packageZip" BYTEA,
    "packageSha256" CHAR(64),
    "supersededAt" TIMESTAMP(3),
    "supersededById" UUID,
    "reopenReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeriodLiquidationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeriodLiquidationVersion_periodId_organizationId_idx" ON "PeriodLiquidationVersion"("periodId", "organizationId");

-- CreateIndex
CREATE INDEX "PeriodLiquidationVersion_organizationId_idx" ON "PeriodLiquidationVersion"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodLiquidationVersion_periodId_version_key" ON "PeriodLiquidationVersion"("periodId", "version");

-- A lo sumo una versión vigente por período.
CREATE UNIQUE INDEX "PeriodLiquidationVersion_current_key" ON "PeriodLiquidationVersion"("periodId") WHERE "supersededAt" IS NULL;

ALTER TABLE "PeriodLiquidationVersion" ADD CONSTRAINT "PeriodLiquidationVersion_state_check" CHECK (
    "version" >= 1
    AND "contentHash" ~ '^[0-9a-f]{64}$'
    AND (("packageZip" IS NULL) = ("packageSha256" IS NULL))
    AND ("packageSha256" IS NULL OR "packageSha256" ~ '^[0-9a-f]{64}$')
    AND ("supersededAt" IS NOT NULL OR ("supersededById" IS NULL AND "reopenReason" IS NULL))
);

-- AddForeignKey
ALTER TABLE "TaxRecord" ADD CONSTRAINT "TaxRecord_invoiceId_organizationId_fkey" FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "Invoice"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodLiquidationVersion" ADD CONSTRAINT "PeriodLiquidationVersion_periodId_organizationId_fkey" FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodLiquidationVersion" ADD CONSTRAINT "PeriodLiquidationVersion_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodLiquidationVersion" ADD CONSTRAINT "PeriodLiquidationVersion_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tabla nueva: sólo la usa el servidor (Prisma, rol propietario). RLS sin
-- políticas y sin privilegios para PUBLIC ni para los roles de la API de
-- Supabase (mismo criterio que 20261106120000_vat_credit_adjustments).
DO $tables$
DECLARE r TEXT;
BEGIN
 ALTER TABLE "PeriodLiquidationVersion" ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON TABLE "PeriodLiquidationVersion" FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE "PeriodLiquidationVersion" FROM %I', r);
 END LOOP;
END
$tables$;

COMMIT;
