-- Importación desde ARCA en tres pasos: descarga -> vista previa -> confirmación.
-- Aditiva: agrega estados, el resumen de la vista previa y el archivo en espera.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ArcaSyncTask" ADD COLUMN "preview" JSONB;
ALTER TABLE "ArcaSyncTask" DROP CONSTRAINT "ArcaSyncTask_status_check";
ALTER TABLE "ArcaSyncTask" ADD CONSTRAINT "ArcaSyncTask_status_check"
    CHECK ("status" IN ('PENDING','RUNNING','PREVIEW','CONFIRMING','DONE','EMPTY','REVIEW','DISCARDED','AUTH_REQUIRED','FAILED'));

CREATE TABLE "ArcaSyncFile" (
    "taskId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "format" TEXT,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArcaSyncFile_pkey" PRIMARY KEY ("taskId", "position"),
    CONSTRAINT "ArcaSyncFile_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArcaSyncTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArcaSyncFile_size_check" CHECK (octet_length("content") BETWEEN 1 AND 2097152)
);

ALTER TABLE "ArcaSyncFile" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "ArcaSyncFile" FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON "ArcaSyncFile" FROM %I', r);
  END LOOP;
END $$;
COMMIT;
