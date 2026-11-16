-- Datos iniciales de IVA Simple (Portal IVA) que el conector completa al abrir
-- el borrador de un período: predeterminados del cliente y elección por período.
-- Aditiva: una columna JSONB nula en Client y una tabla nueva; no modifica ni
-- borra datos existentes. La elección del período vive fuera de "Period" (cuyas
-- escrituras están reservadas a las transiciones de estado).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Client" ADD COLUMN "arcaInitialData" JSONB;

CREATE TABLE "ArcaPeriodSetting" (
    "periodId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "initialData" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArcaPeriodSetting_pkey" PRIMARY KEY ("periodId"),
    CONSTRAINT "ArcaPeriodSetting_periodId_organizationId_fkey"
        FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ArcaPeriodSetting_periodId_organizationId_key" ON "ArcaPeriodSetting"("periodId", "organizationId");

ALTER TABLE "ArcaPeriodSetting" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "ArcaPeriodSetting" FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON "ArcaPeriodSetting" FROM %I', r);
  END LOOP;
END $$;
COMMIT;
