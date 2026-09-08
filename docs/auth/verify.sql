-- Verificación de la migración 20260908021123_org_auth_base.
-- NO se ejecuta automáticamente. Correr a mano, solo lectura, contra dev,
-- antes y después de aplicar la migración (cuando esa aplicación se autorice).

-- ─────────────────────────────────────────────
-- PREFLIGHT (antes de aplicar)
-- ─────────────────────────────────────────────

-- 1. Migraciones ya presentes (esperado: 0_init, 20260907213357_float_to_decimal).
SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at
FROM public."_prisma_migrations" ORDER BY started_at;

-- 2. Filas actuales (esperado hoy: 0 en las 5 tablas de aplicación).
SELECT 'Client' t, count(*) n FROM "Client"
UNION ALL SELECT 'Period',    count(*) FROM "Period"
UNION ALL SELECT 'Invoice',   count(*) FROM "Invoice"
UNION ALL SELECT 'TaxRecord', count(*) FROM "TaxRecord"
UNION ALL SELECT 'Settings',  count(*) FROM "Settings";

-- 3. El índice único global de cuit todavía existe (se elimina en la migración).
SELECT indexname FROM pg_indexes
WHERE schemaname='public' AND tablename='Client' AND indexname='Client_cuit_key';

-- ─────────────────────────────────────────────
-- POST-VERIFICACIÓN (después de aplicar)
-- ─────────────────────────────────────────────

-- 4. Las dos migraciones nuevas + previas, todas finished, sin rollback.
SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at
FROM public."_prisma_migrations" ORDER BY started_at;

-- 5. Tablas nuevas.
SELECT tablename FROM pg_tables
WHERE schemaname='public'
  AND tablename IN ('Profile','Organization','Membership','OrgSetting')
ORDER BY tablename;

-- 6. Enum Role.
SELECT enumlabel FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'Role' ORDER BY e.enumsortorder;

-- 7. Client: cuit ya NO tiene índice único global; sí el compuesto; organizationId NOT NULL.
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename='Client'
  AND indexname IN ('Client_cuit_key','Client_organizationId_cuit_key');
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='Client'
  AND column_name IN ('organizationId','createdById','updatedById');

-- 8. Autoría y timestamps en Period / Invoice / TaxRecord.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('Period','Invoice','TaxRecord')
  AND column_name IN ('createdById','updatedById','createdAt','updatedAt')
ORDER BY table_name, column_name;

-- 9. FKs nuevas (Membership/OrgSetting/Client/... -> Organization/Profile).
SELECT conname, conrelid::regclass::text AS tabla, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE contype='f' AND connamespace='public'::regnamespace
  AND conname LIKE ANY (ARRAY['Membership_%_fkey','OrgSetting_%_fkey','Client_%ById_fkey',
                              'Client_organizationId_fkey','Period_%ById_fkey',
                              'Invoice_%ById_fkey','TaxRecord_%ById_fkey'])
ORDER BY conname;

-- 10. Campos monetarios Decimal (Tarea 2) intactos.
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('Client','Invoice','TaxRecord')
  AND column_name IN ('defaultIibbRate','netAmount','vatRate','vatAmount','totalAmount','amount')
ORDER BY table_name, column_name;

-- 11. Esquemas internos de Supabase sin tocar.
SELECT count(*) AS auth_tables FROM information_schema.tables WHERE table_schema='auth';
SELECT count(*) AS storage_tables FROM information_schema.tables WHERE table_schema='storage';

-- 12. Perfiles huérfanos (esperado: 0). Ver scripts/check-orphan-profiles.ts.
SELECT p.id::text, p.email
FROM public."Profile" p
LEFT JOIN auth.users u ON u.id = p.id
WHERE u.id IS NULL;
