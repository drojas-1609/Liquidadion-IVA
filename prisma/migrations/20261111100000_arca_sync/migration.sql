BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "ArcaSyncSchedule" (
    "clientId" TEXT PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "actorProfileId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "extraDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    CONSTRAINT "ArcaSyncSchedule_clientId_organizationId_fkey"
        FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArcaSyncSchedule_days_check"
        CHECK (cardinality("extraDays") <= 2 AND "extraDays" <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,26,27,28,29,30,31])
);

CREATE UNIQUE INDEX "ArcaSyncSchedule_clientId_organizationId_key" ON "ArcaSyncSchedule" ("clientId", "organizationId");

CREATE TABLE "ArcaSyncTask" (
    "clientId" TEXT NOT NULL,
    "id" TEXT PRIMARY KEY,
    "periodId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorProfileId" UUID NOT NULL,
    "runKey" TEXT NOT NULL,
    "source" TEXT NOT NULL CHECK ("source" IN ('SALES','PURCHASES','RETENTIONS','PERCEPTIONS')),
    "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','RUNNING','DONE','EMPTY','REVIEW','AUTH_REQUIRED','FAILED')),
    "downloaded" INTEGER,
    "imported" INTEGER,
    "duplicates" INTEGER,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ArcaSyncTask_periodId_organizationId_fkey"
        FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ArcaSyncTask_periodId_runKey_source_key" ON "ArcaSyncTask" ("periodId", "runKey", "source");
CREATE UNIQUE INDEX "ArcaSyncTask_one_running_per_client" ON "ArcaSyncTask" ("organizationId", "clientId") WHERE "status" = 'RUNNING';
CREATE INDEX "ArcaSyncTask_status_updatedAt_idx" ON "ArcaSyncTask" ("status", "updatedAt");

ALTER TABLE "ArcaSyncSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArcaSyncTask" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "ArcaSyncSchedule", "ArcaSyncTask" FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON "ArcaSyncSchedule", "ArcaSyncTask" FROM %I', r);
  END LOOP;
END $$;
COMMIT;
