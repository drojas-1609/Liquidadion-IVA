-- Fase A — Modelo contable de comprobantes. Migración M1 (EXPAND).
--
-- Se apila DESPUÉS de:
--   0_init
--   20260907213357_float_to_decimal
--   20260908021123_org_auth_base
--   20260908204819_org_scope_and_audit
-- y NO modifica ninguna de ellas.
--
-- ESTRATEGIA EXPAND/CONTRACT
--   M1 (este archivo) es COMPATIBLE con el código publicado anterior, que sólo
--   escribe las columnas heredadas de Invoice:
--     - columnas contables nuevas NULLABLE y SIN default (NULL = fila heredada
--       sin representar; ningún default fabrica un valor contable). Única
--       excepción: `lidSection` NOT NULL DEFAULT 'GENERAL' (clasificación real
--       de todo lo existente y de lo que escribe el código anterior);
--     - DROP NOT NULL sólo en columnas heredadas (date, type, entityName,
--       entityCuit, vatRate); netAmount/vatAmount/totalAmount siguen NOT NULL;
--     - la FK nueva (periodId, clientId, organizationId) no evalúa filas con
--       clientId NULL (MATCH SIMPLE) y CONVIVE con la FK anterior;
--     - índices únicos parciales y CHECKs aceptan NULL en las columnas nuevas;
--       el CHECK de `category` se crea NOT VALID (sólo filas nuevas);
--     - InvoiceVatLine y PeriodVatSettings son tablas nuevas (el código
--       anterior no las usa).
--   M2 (contract, tarea posterior): backfill idempotente de filas heredadas
--   restantes, SET NOT NULL, retiro de la FK anterior. M3: DROP de columnas
--   heredadas.
--
-- CRÉDITO FISCAL
--   Invoice.directComputableVatCreditAmount = Σ computableVatAmount de las
--   líneas DIRECT_COMPUTABLE. El prorrateo global NO se guarda por comprobante:
--   se calcula por período con PeriodVatSettings.globalCoefficient.
--   Invoice.reportedComputableVatCreditAmount conservará el valor informado por
--   ARCA en la futura importación (NULL en carga manual y en el backfill).
--
-- BACKFILL (fase 4): SÓLO se representan las filas cuya liquidación con el
-- modelo nuevo es EXACTAMENTE igual a la actual. El resto queda heredado
-- (voucherCode NULL), se sigue liquidando con las columnas heredadas y se
-- reporta para revisión antes de M2. Compras: líneas DIRECT_COMPUTABLE con
-- computable = IVA (criterio anterior); ventas: NOT_APPLICABLE. La migración
-- NUNCA aborta por datos; sí aborta (fase 6) si el propio backfill violara un
-- invariante.
--
-- Fuentes oficiales (ARCA), consultadas 2026-09-25:
--   "Libro IVA Digital – Tablas del Sistema"
--   https://www.arca.gob.ar/iva/documentos/Libro-IVA-Digital-Tablas-del-Sistema.pdf
--     alícuotas 0003=0 %, 0004=10,5 %, 0005=21 %, 0006=27 %, 0008=5 %, 0009=2,5 %;
--     comprobantes 001/002/003 (A), 006/007/008 (B), 011/012/013 (C),
--     195/196/197 (clase T, TurIVA); documento 80 = CUIT; moneda PES.
--   "Libro IVA Digital R.G. N° 4597 – Especificaciones" (Revisión 30/07/2025)
--   https://www.afip.gob.ar/iva/documentos/Libro-IVA-Digital-Especificaciones.pdf
--     compras B/C sin alícuotas (Libro Compras, campo 19); crédito fiscal
--     computable por comprobante / global (campo 21 y "CF Computable Global");
--     TurIVA (Ventas campo 23, Compras campo 26).
--
-- Objetos que Prisma 6.19 NO representa (definidos SÓLO acá; protegidos por
-- tests/schema/invoice-model-migration.test.ts; nunca aplicar sin revisar la
-- salida de `prisma migrate diff`/`migrate dev`, que propondría borrarlos):
--   Invoice_sales_voucher_key, Invoice_purchases_voucher_key (UNIQUE parciales)
--   Invoice_category_check, Invoice_model_amounts_nonnegative_check,
--   Invoice_exchange_rate_check, Invoice_direct_credit_check,
--   Invoice_sales_no_direct_credit_check,
--   Invoice_gross_income_base_sales_only_check,
--   InvoiceVatLine_amounts_nonnegative_check,
--   InvoiceVatLine_credit_allocation_check,
--   PeriodVatSettings_global_coefficient_range_check,
--   PeriodVatSettings_coefficient_status_check
--
-- NO referencia el esquema `auth`, NO crea triggers ni funciones persistentes.
-- El único DML es el backfill de Invoice y la creación de sus InvoiceVatLine.
--
-- Esta migración NO se aplica en esta tarea (ni en dev ni en producción).
--
-- ATOMICIDAD EXPLÍCITA (convención de la Tarea 3B): Prisma Migrate no envuelve
-- las migraciones de PostgreSQL en una transacción; este archivo abre la suya.
-- Si cualquier sentencia falla, PostgreSQL revierte TODO el bloque.

BEGIN;

-- ── Fase 1: tipos y columnas nuevas ───────────────────────────────────────

CREATE TYPE "InvoiceSource" AS ENUM ('MANUAL', 'IMPORT');
CREATE TYPE "VatCreditAllocation" AS ENUM ('NOT_APPLICABLE', 'DIRECT_COMPUTABLE', 'DIRECT_NON_COMPUTABLE', 'GLOBAL_PRORATION');
CREATE TYPE "LidSection" AS ENUM ('GENERAL', 'TURIVA');
CREATE TYPE "CreditProrationMode" AS ENUM ('NONE', 'DIRECT', 'GLOBAL', 'DIRECT_AND_GLOBAL');
CREATE TYPE "CoefficientStatus" AS ENUM ('PROVISIONAL', 'DEFINITIVE');

ALTER TABLE "Invoice"
  ADD COLUMN "clientId" TEXT,
  ADD COLUMN "source" "InvoiceSource",
  ADD COLUMN "voucherCode" INTEGER,
  ADD COLUMN "numberTo" INTEGER,
  ADD COLUMN "voucherDate" DATE,
  ADD COLUMN "counterpartyDocType" INTEGER,
  ADD COLUMN "counterpartyDocNumber" TEXT,
  ADD COLUMN "counterpartyName" TEXT,
  ADD COLUMN "currencyCode" CHAR(3),
  ADD COLUMN "exchangeRate" DECIMAL(19,6),
  ADD COLUMN "taxedNetAmount" DECIMAL(18,2),
  ADD COLUMN "totalVatAmount" DECIMAL(18,2),
  ADD COLUMN "directComputableVatCreditAmount" DECIMAL(18,2),
  ADD COLUMN "reportedComputableVatCreditAmount" DECIMAL(18,2),
  ADD COLUMN "netWithoutVatBreakdownAmount" DECIMAL(18,2),
  ADD COLUMN "nonTaxedAmount" DECIMAL(18,2),
  ADD COLUMN "exemptAmount" DECIMAL(18,2),
  ADD COLUMN "vatPerceptionAmount" DECIMAL(18,2),
  ADD COLUMN "nationalPerceptionAmount" DECIMAL(18,2),
  ADD COLUMN "iibbPerceptionAmount" DECIMAL(18,2),
  ADD COLUMN "municipalPerceptionAmount" DECIMAL(18,2),
  ADD COLUMN "internalTaxesAmount" DECIMAL(18,2),
  ADD COLUMN "otherTaxesAmount" DECIMAL(18,2),
  ADD COLUMN "grossIncomeTaxBaseAmount" DECIMAL(18,2),
  ADD COLUMN "voucherTotalAmount" DECIMAL(18,2),
  ADD COLUMN "turivaRefundAmount" DECIMAL(18,2),
  ADD COLUMN "operationCode" CHAR(1),
  ADD COLUMN "lidSection" "LidSection" NOT NULL DEFAULT 'GENERAL';

-- Columnas heredadas: dejan de ser obligatorias (el código anterior las sigue
-- completando siempre; compatible). Se eliminan en M3.
ALTER TABLE "Invoice"
  ALTER COLUMN "date" DROP NOT NULL,
  ALTER COLUMN "type" DROP NOT NULL,
  ALTER COLUMN "entityName" DROP NOT NULL,
  ALTER COLUMN "entityCuit" DROP NOT NULL,
  ALTER COLUMN "vatRate" DROP NOT NULL;

-- ── Fase 2: tablas nuevas ─────────────────────────────────────────────────

CREATE TABLE "InvoiceVatLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "vatRateCode" INTEGER NOT NULL,
    "netAmount" DECIMAL(18,2) NOT NULL,
    "vatAmount" DECIMAL(18,2) NOT NULL,
    "creditAllocation" "VatCreditAllocation" NOT NULL,
    "computableVatAmount" DECIMAL(18,2),
    "computableOverridden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceVatLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PeriodVatSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "creditProrationMode" "CreditProrationMode" NOT NULL DEFAULT 'NONE',
    "globalCoefficient" DECIMAL(11,10),
    "globalCoefficientStatus" "CoefficientStatus",
    "turivaIncluded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "PeriodVatSettings_pkey" PRIMARY KEY ("id")
);

-- ── Fase 3: destinos de FK compuestas e índices ───────────────────────────

CREATE UNIQUE INDEX "Period_id_clientId_organizationId_key" ON "Period"("id", "clientId", "organizationId");
CREATE UNIQUE INDEX "Invoice_id_organizationId_key" ON "Invoice"("id", "organizationId");
CREATE INDEX "Invoice_periodId_clientId_organizationId_idx" ON "Invoice"("periodId", "clientId", "organizationId");
CREATE UNIQUE INDEX "InvoiceVatLine_invoiceId_vatRateCode_creditAllocation_key" ON "InvoiceVatLine"("invoiceId", "vatRateCode", "creditAllocation");
CREATE INDEX "InvoiceVatLine_invoiceId_organizationId_idx" ON "InvoiceVatLine"("invoiceId", "organizationId");
CREATE INDEX "InvoiceVatLine_organizationId_idx" ON "InvoiceVatLine"("organizationId");
CREATE UNIQUE INDEX "PeriodVatSettings_periodId_key" ON "PeriodVatSettings"("periodId");
CREATE UNIQUE INDEX "PeriodVatSettings_periodId_organizationId_key" ON "PeriodVatSettings"("periodId", "organizationId");
CREATE INDEX "PeriodVatSettings_organizationId_idx" ON "PeriodVatSettings"("organizationId");

-- ── Fase 4: backfill de Invoice (sólo filas representables EXACTAMENTE) ───

CREATE TEMP TABLE "_fa_candidates" ON COMMIT DROP AS
SELECT
  i."id",
  p."clientId",
  vt."code"   AS "voucherCode",
  vt."letter" AS "letter",
  vr."code"   AS "rateCode",
  (i."category" = 'PURCHASES' AND vt."letter" IN ('B', 'C')) AS "noBreakdown"
FROM "Invoice" i
JOIN "Period" p
  ON p."id" = i."periodId" AND p."organizationId" = i."organizationId"
JOIN (VALUES
  ('FC A', 1,  1, 'A'), ('ND A', 2,  1, 'A'), ('NC A', 3,  -1, 'A'),
  ('FC B', 6,  1, 'B'), ('ND B', 7,  1, 'B'), ('NC B', 8,  -1, 'B'),
  ('FC C', 11, 1, 'C'), ('ND C', 12, 1, 'C'), ('NC C', 13, -1, 'C')
) AS vt("label", "code", "sign", "letter")
  ON vt."label" = i."type"
JOIN (VALUES
  (3, 0::numeric), (4, 10.5::numeric), (5, 21::numeric),
  (6, 27::numeric), (8, 5::numeric),  (9, 2.5::numeric)
) AS vr("code", "rate")
  ON vr."rate" = i."vatRate"
WHERE i."voucherCode" IS NULL
  AND i."category" IN ('SALES', 'PURCHASES')
  AND i."date" IS NOT NULL
  AND i."entityName" IS NOT NULL
  AND i."entityCuit" ~ '^[0-9]{2}-[0-9]{8}-[0-9]$'
  -- signo de los importes heredados coherente con el código del comprobante
  -- (una NC guardada en positivo NO se representa: cambiaría la liquidación)
  AND (
        (vt."sign" = 1  AND i."netAmount" >= 0 AND i."vatAmount" >= 0 AND i."totalAmount" >= 0)
     OR (vt."sign" = -1 AND i."netAmount" <= 0 AND i."vatAmount" <= 0 AND i."totalAmount" <= 0)
  )
  -- total heredado = neto + IVA (fórmula del alta anterior)
  AND i."totalAmount" = i."netAmount" + i."vatAmount"
  -- compras B/C: sólo representables sin IVA discriminado
  AND NOT (
        i."category" = 'PURCHASES' AND vt."letter" IN ('B', 'C')
    AND (i."vatRate" <> 0 OR i."vatAmount" <> 0)
  );

-- Duplicados que violarían los índices únicos parciales: se representa sólo
-- el más antiguo; los demás quedan heredados para revisión.
DELETE FROM "_fa_candidates" c
USING (
  SELECT c2."id",
         ROW_NUMBER() OVER (
           PARTITION BY c2."clientId", i."category", c2."voucherCode", i."pointOfSale", i."number",
                        CASE WHEN i."category" = 'PURCHASES'
                             THEN regexp_replace(i."entityCuit", '[^0-9]', '', 'g') END
           ORDER BY i."createdAt", i."id"
         ) AS "rn"
  FROM "_fa_candidates" c2
  JOIN "Invoice" i ON i."id" = c2."id"
) d
WHERE d."id" = c."id" AND d."rn" > 1;

-- `date` es TIMESTAMP(3) sin zona que guarda la hora UTC (Prisma): el cast
-- directo a DATE toma el día UTC sin depender del TimeZone de la sesión.
UPDATE "Invoice" i SET
  "clientId"                          = c."clientId",
  "source"                            = 'MANUAL',
  "voucherCode"                       = c."voucherCode",
  "voucherDate"                       = i."date"::date,
  "counterpartyDocType"               = 80,
  "counterpartyDocNumber"             = regexp_replace(i."entityCuit", '[^0-9]', '', 'g'),
  "counterpartyName"                  = i."entityName",
  "currencyCode"                      = 'PES',
  "exchangeRate"                      = 1,
  "taxedNetAmount"                    = CASE WHEN c."noBreakdown" THEN 0 ELSE abs(i."netAmount") END,
  "totalVatAmount"                    = CASE WHEN c."noBreakdown" THEN 0 ELSE abs(i."vatAmount") END,
  "netWithoutVatBreakdownAmount"      = CASE WHEN c."noBreakdown" THEN abs(i."netAmount") ELSE 0 END,
  -- compras: todo el IVA era crédito DIRECTO (criterio anterior); ventas: 0
  "directComputableVatCreditAmount"   = CASE WHEN i."category" = 'PURCHASES' AND NOT c."noBreakdown"
                                             THEN abs(i."vatAmount") ELSE 0 END,
  "reportedComputableVatCreditAmount" = NULL,
  "nonTaxedAmount"                    = 0,
  "exemptAmount"                      = 0,
  "vatPerceptionAmount"               = 0,
  "nationalPerceptionAmount"          = 0,
  "iibbPerceptionAmount"              = 0,
  "municipalPerceptionAmount"         = 0,
  "internalTaxesAmount"               = 0,
  "otherTaxesAmount"                  = 0,
  -- ventas: base IIBB = neto (criterio anterior); compras: NULL
  "grossIncomeTaxBaseAmount"          = CASE WHEN i."category" = 'SALES' THEN abs(i."netAmount") ELSE NULL END,
  "voucherTotalAmount"                = abs(i."totalAmount"),
  -- sin reintegro TurIVA en los datos anteriores
  "turivaRefundAmount"                = 0
FROM "_fa_candidates" c
WHERE c."id" = i."id";

-- ── Fase 5: una línea de IVA por comprobante representado (salvo compras B/C)
-- Compras: DIRECT_COMPUTABLE con computable = IVA (criterio anterior).
-- Ventas:  NOT_APPLICABLE con computable NULL.

INSERT INTO "InvoiceVatLine"
  ("id", "organizationId", "invoiceId", "vatRateCode", "netAmount", "vatAmount",
   "creditAllocation", "computableVatAmount", "computableOverridden")
SELECT
  gen_random_uuid()::text, i."organizationId", i."id", c."rateCode", abs(i."netAmount"), abs(i."vatAmount"),
  CASE WHEN i."category" = 'PURCHASES' THEN 'DIRECT_COMPUTABLE' ELSE 'NOT_APPLICABLE' END::"VatCreditAllocation",
  CASE WHEN i."category" = 'PURCHASES' THEN abs(i."vatAmount") ELSE NULL END,
  false
FROM "_fa_candidates" c
JOIN "Invoice" i ON i."id" = c."id"
WHERE NOT c."noBreakdown";

-- ── Fase 6: verificación del backfill (aborta TODO si un invariante falla) ─

DO $$
DECLARE
  n_total     bigint;
  n_modeled   bigint;
  n_legacy    bigint;
  n_bad       bigint;
BEGIN
  -- sumas de líneas = totales del encabezado; crédito directo = Σ computable directo
  SELECT count(*) INTO n_bad
  FROM "Invoice" i
  LEFT JOIN (
    SELECT "invoiceId",
           sum("netAmount") AS net,
           sum("vatAmount") AS vat,
           sum(CASE WHEN "creditAllocation" = 'DIRECT_COMPUTABLE' THEN "computableVatAmount" ELSE 0 END) AS direct
    FROM "InvoiceVatLine" GROUP BY "invoiceId"
  ) l ON l."invoiceId" = i."id"
  WHERE i."voucherCode" IS NOT NULL
    AND (i."taxedNetAmount" <> COALESCE(l.net, 0)
      OR i."totalVatAmount" <> COALESCE(l.vat, 0)
      OR i."directComputableVatCreditAmount" <> COALESCE(l.direct, 0));
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'Fase A M1: % comprobantes con líneas de IVA que no suman el encabezado', n_bad;
  END IF;

  -- atribución por categoría: ventas NOT_APPLICABLE; compras nunca NOT_APPLICABLE
  SELECT count(*) INTO n_bad
  FROM "InvoiceVatLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
  WHERE (i."category" = 'SALES' AND l."creditAllocation" <> 'NOT_APPLICABLE')
     OR (i."category" = 'PURCHASES' AND l."creditAllocation" = 'NOT_APPLICABLE');
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'Fase A M1: % líneas con atribución incompatible con la categoría', n_bad;
  END IF;

  -- fórmula del total (el reintegro TurIVA NO forma parte del total)
  SELECT count(*) INTO n_bad FROM "Invoice"
  WHERE "voucherCode" IS NOT NULL
    AND "voucherTotalAmount" <> "taxedNetAmount" + "totalVatAmount" + "netWithoutVatBreakdownAmount"
        + "nonTaxedAmount" + "exemptAmount" + "vatPerceptionAmount" + "nationalPerceptionAmount"
        + "iibbPerceptionAmount" + "municipalPerceptionAmount" + "internalTaxesAmount" + "otherTaxesAmount";
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'Fase A M1: % comprobantes cuyo total no cumple la fórmula', n_bad;
  END IF;

  -- compras B/C: cero líneas
  SELECT count(*) INTO n_bad
  FROM "Invoice" i JOIN "InvoiceVatLine" l ON l."invoiceId" = i."id"
  WHERE i."category" = 'PURCHASES' AND i."voucherCode" IN (6, 7, 8, 11, 12, 13);
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'Fase A M1: % líneas de IVA en compras B/C', n_bad;
  END IF;

  -- la liquidación con el modelo nuevo es idéntica a la heredada, fila por fila
  SELECT count(*) INTO n_bad FROM "Invoice"
  WHERE "voucherCode" IS NOT NULL
    AND (
         (CASE WHEN "voucherCode" IN (3, 8, 13) THEN -1 ELSE 1 END)
           * ("taxedNetAmount" + "netWithoutVatBreakdownAmount") <> "netAmount"
      OR (CASE WHEN "voucherCode" IN (3, 8, 13) THEN -1 ELSE 1 END)
           * (CASE WHEN "category" = 'SALES' THEN "totalVatAmount" ELSE "directComputableVatCreditAmount" END) <> "vatAmount"
      OR (CASE WHEN "voucherCode" IN (3, 8, 13) THEN -1 ELSE 1 END) * "voucherTotalAmount" <> "totalAmount"
    );
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'Fase A M1: % comprobantes cuya liquidación cambiaría', n_bad;
  END IF;

  SELECT count(*) INTO n_total FROM "Invoice";
  SELECT count(*) INTO n_modeled FROM "Invoice" WHERE "voucherCode" IS NOT NULL;
  n_legacy := n_total - n_modeled;
  -- Sólo conteos (sin datos fiscales ni identificadores).
  RAISE NOTICE 'Fase A M1: comprobantes=%, representados=%, heredados para revisión=%',
    n_total, n_modeled, n_legacy;
END $$;

-- ── Fase 7: claves foráneas ───────────────────────────────────────────────

-- Convive con Invoice_periodId_organizationId_fkey (3B). Con clientId NULL no
-- se evalúa (MATCH SIMPLE): compatible con filas del código anterior.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_periodId_clientId_organizationId_fkey"
  FOREIGN KEY ("periodId", "clientId", "organizationId")
  REFERENCES "Period"("id", "clientId", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Las líneas son parte del comprobante: se borran con él.
ALTER TABLE "InvoiceVatLine" ADD CONSTRAINT "InvoiceVatLine_invoiceId_organizationId_fkey"
  FOREIGN KEY ("invoiceId", "organizationId")
  REFERENCES "Invoice"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- La configuración es parte del período: se borra con él. FK compuesta por
-- organización (aislamiento).
ALTER TABLE "PeriodVatSettings" ADD CONSTRAINT "PeriodVatSettings_periodId_organizationId_fkey"
  FOREIGN KEY ("periodId", "organizationId")
  REFERENCES "Period"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PeriodVatSettings" ADD CONSTRAINT "PeriodVatSettings_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PeriodVatSettings" ADD CONSTRAINT "PeriodVatSettings_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Fase 8: unicidad de comprobantes en TODOS los períodos del cliente ────
-- Filas con NULL en estas columnas (heredadas) no colisionan entre sí.

-- Ventas: el emisor es el propio cliente.
CREATE UNIQUE INDEX "Invoice_sales_voucher_key" ON "Invoice"
  ("clientId", "voucherCode", "pointOfSale", "number")
  WHERE "category" = 'SALES';

-- Compras: el emisor es la contraparte (documento del vendedor).
CREATE UNIQUE INDEX "Invoice_purchases_voucher_key" ON "Invoice"
  ("clientId", "counterpartyDocType", "counterpartyDocNumber", "voucherCode", "pointOfSale", "number")
  WHERE "category" = 'PURCHASES';

-- ── Fase 9: restricciones CHECK (NULL las satisface: compatibles) ─────────

-- NOT VALID: se exige a filas nuevas/modificadas sin revalidar las heredadas.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_category_check"
  CHECK ("category" IN ('SALES', 'PURCHASES')) NOT VALID;

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_model_amounts_nonnegative_check" CHECK (
      ("taxedNetAmount" IS NULL OR "taxedNetAmount" >= 0)
  AND ("totalVatAmount" IS NULL OR "totalVatAmount" >= 0)
  AND ("directComputableVatCreditAmount" IS NULL OR "directComputableVatCreditAmount" >= 0)
  AND ("reportedComputableVatCreditAmount" IS NULL OR "reportedComputableVatCreditAmount" >= 0)
  AND ("netWithoutVatBreakdownAmount" IS NULL OR "netWithoutVatBreakdownAmount" >= 0)
  AND ("nonTaxedAmount" IS NULL OR "nonTaxedAmount" >= 0)
  AND ("exemptAmount" IS NULL OR "exemptAmount" >= 0)
  AND ("vatPerceptionAmount" IS NULL OR "vatPerceptionAmount" >= 0)
  AND ("nationalPerceptionAmount" IS NULL OR "nationalPerceptionAmount" >= 0)
  AND ("iibbPerceptionAmount" IS NULL OR "iibbPerceptionAmount" >= 0)
  AND ("municipalPerceptionAmount" IS NULL OR "municipalPerceptionAmount" >= 0)
  AND ("internalTaxesAmount" IS NULL OR "internalTaxesAmount" >= 0)
  AND ("otherTaxesAmount" IS NULL OR "otherTaxesAmount" >= 0)
  AND ("grossIncomeTaxBaseAmount" IS NULL OR "grossIncomeTaxBaseAmount" >= 0)
  AND ("voucherTotalAmount" IS NULL OR "voucherTotalAmount" >= 0)
  AND ("turivaRefundAmount" IS NULL OR "turivaRefundAmount" >= 0)
);

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_exchange_rate_check" CHECK (
  "exchangeRate" IS NULL
  OR ("exchangeRate" > 0 AND ("currencyCode" IS DISTINCT FROM 'PES' OR "exchangeRate" = 1))
);

-- El crédito directo nunca supera el IVA liquidado del comprobante.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_direct_credit_check" CHECK (
  "directComputableVatCreditAmount" IS NULL OR "totalVatAmount" IS NULL
  OR "directComputableVatCreditAmount" <= "totalVatAmount"
);

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_sales_no_direct_credit_check" CHECK (
  "category" <> 'SALES' OR "directComputableVatCreditAmount" IS NULL OR "directComputableVatCreditAmount" = 0
);

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_gross_income_base_sales_only_check" CHECK (
  "category" = 'SALES' OR "grossIncomeTaxBaseAmount" IS NULL
);

ALTER TABLE "InvoiceVatLine" ADD CONSTRAINT "InvoiceVatLine_amounts_nonnegative_check" CHECK (
  "netAmount" >= 0 AND "vatAmount" >= 0
);

-- Atribución del crédito por línea:
--   DIRECT_COMPUTABLE:     0 <= computable <= IVA (corrección manual admitida)
--   DIRECT_NON_COMPUTABLE: computable = 0, sin corrección
--   GLOBAL_PRORATION / NOT_APPLICABLE: computable NULL, sin corrección
ALTER TABLE "InvoiceVatLine" ADD CONSTRAINT "InvoiceVatLine_credit_allocation_check" CHECK (
     ("creditAllocation" = 'DIRECT_COMPUTABLE'
        AND "computableVatAmount" IS NOT NULL
        AND "computableVatAmount" >= 0
        AND "computableVatAmount" <= "vatAmount")
  OR ("creditAllocation" = 'DIRECT_NON_COMPUTABLE'
        AND "computableVatAmount" = 0
        AND NOT "computableOverridden")
  OR ("creditAllocation" IN ('GLOBAL_PRORATION', 'NOT_APPLICABLE')
        AND "computableVatAmount" IS NULL
        AND NOT "computableOverridden")
);

-- Coeficiente de prorrateo global entre 0 y 1.
ALTER TABLE "PeriodVatSettings" ADD CONSTRAINT "PeriodVatSettings_global_coefficient_range_check" CHECK (
  "globalCoefficient" IS NULL OR ("globalCoefficient" >= 0 AND "globalCoefficient" <= 1)
);

-- Coeficiente y su estado (provisional/definitivo) van juntos.
ALTER TABLE "PeriodVatSettings" ADD CONSTRAINT "PeriodVatSettings_coefficient_status_check" CHECK (
  ("globalCoefficient" IS NULL) = ("globalCoefficientStatus" IS NULL)
);

COMMIT;
