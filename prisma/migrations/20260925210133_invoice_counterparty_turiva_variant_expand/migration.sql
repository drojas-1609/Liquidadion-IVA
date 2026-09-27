-- PR B — Gestión manual de comprobantes. Migración EXPAND.
--
-- Se apila DESPUÉS de:
--   0_init
--   20260907213357_float_to_decimal
--   20260908021123_org_auth_base
--   20260908204819_org_scope_and_audit
--   20260925030000_invoice_accounting_model_expand
-- y NO modifica ninguna de ellas ni borra sus objetos.
--
-- COMPATIBILIDAD
--   - Tres columnas nuevas NULLABLE, SIN default y SIN backfill. Todas las filas
--     existentes quedan en NULL (fila heredada, importada o "no aplica").
--   - La obligatoriedad en nuevas altas manuales (condición de la contraparte,
--     relación TurIVA en 195–197 y variante en 001–003) y los cortes de fecha
--     se controlan en la APLICACIÓN, no aquí: no se impone en la base ninguna
--     obligatoriedad que pueda invalidar registros existentes antes del
--     preflight de datos.
--
-- SEMÁNTICA NULL DE PostgreSQL
--   Un CHECK cuyo resultado es NULL se considera CUMPLIDO. Por eso las
--   expresiones exigen explícitamente "IS NOT NULL" sobre el operando que
--   condiciona (voucherCode, source) en lugar de confiar en "x IN (...)".
--
-- ALCANCE
--   - La clase A con leyenda de retención entre el 11/11/2019 y el 30/11/2025
--     NO se almacena como variante y NO integra ningún CHECK: su código
--     histórico no está confirmado (pendiente normativo).
--   - El comprobante 063 queda fuera: ningún CHECK lo menciona.
--   - Convenio Multilateral queda fuera.
--
-- Objetos que Prisma NO representa (viven sólo aquí; protegidos por
-- tests/schema/invoice-counterparty-variant-migration.test.ts):
--   Invoice_counterparty_vat_condition_check,
--   Invoice_turiva_relation_code_check,
--   Invoice_turiva_relation_voucher_check,
--   Invoice_voucher_variant_check,
--   Invoice_voucher_variant_code_check,
--   Invoice_voucher_variant_manual_check,
--   Invoice_turiva_section_check (NOT VALID)

BEGIN;

ALTER TABLE "Invoice" ADD COLUMN "counterpartyVatConditionCode" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "turivaRelationCode" VARCHAR(4);
ALTER TABLE "Invoice" ADD COLUMN "voucherVariant" VARCHAR(32);

-- Condición frente al IVA de la contraparte: catálogo oficial "Tipos de
-- responsables" (AFIP, V.0 06/02/2025) o NULL.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_counterparty_vat_condition_check" CHECK (
  "counterpartyVatConditionCode" IS NULL
  OR "counterpartyVatConditionCode" IN (1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16)
);

-- Relación emisor-receptor TurIVA (tabla 6.1 del régimen informativo F.8089),
-- texto de 4 caracteres con ceros a la izquierda, o NULL.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_turiva_relation_code_check" CHECK (
  "turivaRelationCode" IS NULL
  OR "turivaRelationCode" IN ('0001', '0002', '0003', '0004', '0005', '0006')
);

-- Relación TurIVA sólo en comprobantes 195–197, en TODA fila (research-report.md
-- §11), cualquiera sea source (MANUAL, IMPORT o NULL). Exige voucherCode NO
-- NULL: con voucherCode NULL la forma "IN (...)" daría NULL y el CHECK se
-- cumpliría. Las filas existentes tienen turivaRelationCode NULL y lo cumplen.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_turiva_relation_voucher_check" CHECK (
  "turivaRelationCode" IS NULL
  OR ("voucherCode" IS NOT NULL AND "voucherCode" IN (195, 196, 197))
);

-- Variante de comprobante: dominio inicial respaldado y usado por el PR B.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_voucher_variant_check" CHECK (
  "voucherVariant" IS NULL
  OR "voucherVariant" IN ('NONE', 'PAGO_EN_CBU_INFORMADA')
);

-- Variante sólo en 001, 002 y 003 (voucherCode NO NULL).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_voucher_variant_code_check" CHECK (
  "voucherVariant" IS NULL
  OR ("voucherCode" IS NOT NULL AND "voucherCode" IN (1, 2, 3))
);

-- Variante sólo en cargas MANUALES (source NO NULL).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_voucher_variant_manual_check" CHECK (
  "voucherVariant" IS NULL
  OR ("source" IS NOT NULL AND "source" = 'MANUAL')
);

-- Comprobantes clase T (195–197) en la pestaña TURIVA. NOT VALID: se crea ahora
-- sin revisar las filas anteriores, pero SÍ controla todo INSERT y todo UPDATE
-- posterior (incluidas actualizaciones de filas viejas). El preflight de datos
-- es previo a VALIDATE CONSTRAINT (no a este ADD CONSTRAINT ... NOT VALID);
-- esta migración no ejecuta VALIDATE CONSTRAINT. No incluye el 063.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_turiva_section_check" CHECK (
  "voucherCode" IS NULL
  OR "voucherCode" NOT IN (195, 196, 197)
  OR "lidSection" = 'TURIVA'
) NOT VALID;

COMMIT;
