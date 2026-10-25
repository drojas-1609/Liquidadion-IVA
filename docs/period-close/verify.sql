-- Verificación de la migración 20261009120000_period_close_reopen.
-- NO se ejecuta automáticamente. Correr a mano, en modo lectura, contra DEV,
-- antes y después de aplicar la migración. Ninguna consulta modifica datos.

-- ─────────────────────────────────────────────────────────────
-- PREFLIGHT (antes de aplicar) — solo lectura
-- ─────────────────────────────────────────────────────────────

-- 1. Migraciones aplicadas (la última esperada: 20260925210133_…_expand).
SELECT migration_name, finished_at
FROM "_prisma_migrations"
ORDER BY started_at DESC
LIMIT 3;

-- 2. Las columnas y el tipo NO existen todavía (esperado: 0 filas).
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'Period'
  AND column_name IN ('status', 'closedAt', 'closedById');
SELECT typname FROM pg_type WHERE typname = 'PeriodStatus';

-- 3. Tipo de Profile.id (esperado: uuid).
SELECT data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'Profile' AND column_name = 'id';

-- 4. Cantidad de períodos (referencia para el post).
SELECT count(*) AS periodos FROM "Period";

-- ─────────────────────────────────────────────────────────────
-- POST-VERIFICACIÓN (después de aplicar) — solo lectura
-- ─────────────────────────────────────────────────────────────

-- 5. Columnas nuevas (esperado: status USER-DEFINED NOT NULL default 'OPEN';
--    closedAt timestamp nullable; closedById uuid nullable).
SELECT column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'Period'
  AND column_name IN ('status', 'closedAt', 'closedById')
ORDER BY column_name;

-- 6. Enum (esperado: OPEN, CLOSED).
SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'PeriodStatus' ORDER BY e.enumsortorder;

-- 7. Restricciones nuevas (esperado: Period_closedById_fkey ON DELETE SET NULL
--    y Period_closed_state_check).
SELECT conname, pg_get_constraintdef(oid) AS definicion
FROM pg_constraint
WHERE conrelid = '"Period"'::regclass
  AND conname IN ('Period_closedById_fkey', 'Period_closed_state_check');

-- 8. Todos los períodos existentes quedaron abiertos y sin datos de cierre
--    (esperado: una sola fila OPEN con el total del paso 4 y 0 con cierre).
SELECT status, count(*) AS periodos,
       count(*) FILTER (WHERE "closedAt" IS NOT NULL OR "closedById" IS NOT NULL) AS con_cierre
FROM "Period" GROUP BY status;
