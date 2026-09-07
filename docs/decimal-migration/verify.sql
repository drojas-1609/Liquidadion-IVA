-- Verificación de la migración 20260907213357_float_to_decimal.
-- NO se ejecuta automáticamente. Correr a mano, en modo lectura, contra la
-- base donde se vaya a aplicar (dev/preview), antes y después de la migración.

-- ─────────────────────────────────────────────────────────────
-- PREFLIGHT (antes de aplicar) — solo lectura
-- ─────────────────────────────────────────────────────────────

-- 1. Cuántas filas hay (esperado hoy: 0 en las tres tablas).
SELECT 'Client' AS tabla, count(*) AS filas FROM "Client"
UNION ALL SELECT 'Invoice',   count(*) FROM "Invoice"
UNION ALL SELECT 'TaxRecord', count(*) FROM "TaxRecord";

-- 2. Tipos de columna actuales (esperado antes: double precision).
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('Client','Invoice','TaxRecord')
  AND column_name IN ('defaultIibbRate','netAmount','vatRate','vatAmount','totalAmount','amount')
ORDER BY table_name, column_name;

-- 3. Detección de datos que perderían precisión al redondear (si hubiera filas).
--    Devuelve las filas cuyo valor NO coincide con su versión redondeada a la
--    escala destino. Idealmente: 0 filas.
SELECT id, "netAmount" FROM "Invoice"
WHERE "netAmount"::numeric <> ROUND("netAmount"::numeric, 2);
SELECT id, "vatRate" FROM "Invoice"
WHERE "vatRate"::numeric <> ROUND("vatRate"::numeric, 6);
SELECT id, "vatAmount" FROM "Invoice"
WHERE "vatAmount"::numeric <> ROUND("vatAmount"::numeric, 2);
SELECT id, "totalAmount" FROM "Invoice"
WHERE "totalAmount"::numeric <> ROUND("totalAmount"::numeric, 2);
SELECT id, "amount" FROM "TaxRecord"
WHERE "amount"::numeric <> ROUND("amount"::numeric, 2);
SELECT id, "defaultIibbRate" FROM "Client"
WHERE "defaultIibbRate"::numeric <> ROUND("defaultIibbRate"::numeric, 6);

-- 4. Coherencia contable de comprobantes existentes (informativo).
--    Filas donde totalAmount != netAmount + vatAmount con las reglas nuevas.
SELECT id, "netAmount", "vatAmount", "totalAmount"
FROM "Invoice"
WHERE ROUND("totalAmount"::numeric, 2)
      <> ROUND("netAmount"::numeric, 2) + ROUND("vatAmount"::numeric, 2);

-- ─────────────────────────────────────────────────────────────
-- POST-VERIFICACIÓN (después de aplicar) — solo lectura
-- ─────────────────────────────────────────────────────────────

-- 5. Tipos y escalas destino.
--    Esperado: defaultIibbRate/vatRate = numeric(9,6); netAmount/vatAmount/
--    totalAmount/amount = numeric(18,2).
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('Client','Invoice','TaxRecord')
  AND column_name IN ('defaultIibbRate','netAmount','vatRate','vatAmount','totalAmount','amount')
ORDER BY table_name, column_name;

-- 6. Default de Client.defaultIibbRate (esperado: 3.000000).
SELECT column_name, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'Client'
  AND column_name = 'defaultIibbRate';

-- 7. La migración quedó registrada.
SELECT migration_name, finished_at, rolled_back_at
FROM "_prisma_migrations" ORDER BY started_at;

-- 8. `0_init` intacta y esquemas internos de Supabase sin tocar.
SELECT count(*) AS auth_tables
FROM information_schema.tables WHERE table_schema = 'auth';
SELECT count(*) AS storage_tables
FROM information_schema.tables WHERE table_schema = 'storage';
