BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE "ArcaWsaaTicket" (
 "key" TEXT PRIMARY KEY,
 "ciphertext" TEXT,
 "expiresAt" TIMESTAMPTZ(3),
 "blockedUntil" TIMESTAMPTZ(3),
 "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "ArcaWsaaTicket_payload_check" CHECK (("ciphertext" IS NULL) = ("expiresAt" IS NULL))
);
ALTER TABLE "ArcaWsaaTicket" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "ArcaWsaaTicket" FROM PUBLIC;
-- En Supabase existen estos roles; en PostgreSQL local pueden no existir.
DO $roles$
DECLARE r TEXT;
BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE "ArcaWsaaTicket" FROM %I', r);
 END LOOP;
END
$roles$;
COMMIT;
