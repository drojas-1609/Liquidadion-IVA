BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE "ArcaClientCredential" (
    "clientId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetCuit" TEXT NOT NULL,
    "envelope" TEXT NOT NULL,
    CONSTRAINT "ArcaClientCredential_pkey" PRIMARY KEY ("clientId", "organizationId"),
    CONSTRAINT "ArcaClientCredential_clientId_organizationId_fkey"
        FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "ArcaClientCredential" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "ArcaClientCredential" FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON "ArcaClientCredential" FROM %I', r);
  END LOOP;
END $$;
COMMIT;
