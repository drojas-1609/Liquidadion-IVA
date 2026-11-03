-- ARCA en producción: interruptor, habilitación por organización, cupos propios
-- compartidos y reserva de emisión WSAA. Aditiva; no toca tablas de negocio.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "ArcaWsaaTicket" ADD COLUMN "leaseId" TEXT, ADD COLUMN "leaseUntil" TIMESTAMPTZ(3);
ALTER TABLE "ArcaWsaaTicket" ADD CONSTRAINT "ArcaWsaaTicket_lease_check" CHECK (("leaseId" IS NULL) = ("leaseUntil" IS NULL));

CREATE TABLE "ArcaPadronControl" (
 "id" TEXT PRIMARY KEY,
 "enabled" BOOLEAN NOT NULL DEFAULT false,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ArcaPadronControl_singleton_check" CHECK ("id" = 'global')
);
INSERT INTO "ArcaPadronControl" ("id", "enabled") VALUES ('global', false);

CREATE TABLE "ArcaPadronOrganization" (
 "organizationId" TEXT PRIMARY KEY,
 "enabled" BOOLEAN NOT NULL DEFAULT false,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ArcaPadronOrganization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ArcaLookupQuota" (
 "key" TEXT PRIMARY KEY,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ArcaLookupQuota_key_check" CHECK ("key" ~ '^[uoc]:[A-Za-z0-9_-]{1,80}$')
);
CREATE TABLE "ArcaLookupQuotaEvent" (
 "id" BIGSERIAL PRIMARY KEY,
 "key" TEXT NOT NULL,
 "at" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "ArcaLookupQuotaEvent_key_at_idx" ON "ArcaLookupQuotaEvent"("key", "at");

-- Acceso sólo del backend propietario: RLS sin políticas y sin privilegios API.
DO $tables$
DECLARE t TEXT; r TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY['ArcaPadronControl', 'ArcaPadronOrganization', 'ArcaLookupQuota', 'ArcaLookupQuotaEvent'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
  END LOOP;
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
  EXECUTE format('REVOKE ALL ON SEQUENCE %I FROM %I', 'ArcaLookupQuotaEvent_id_seq', r);
 END LOOP;
END
$tables$;
COMMIT;
