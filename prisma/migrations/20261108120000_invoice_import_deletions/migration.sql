-- Comprobantes IMPORTADOS eliminados de la aplicación: registro mínimo para que
-- una nueva importación del mismo comprobante no lo vuelva a cargar en
-- silencio (queda para revisar, salvo que el usuario lo confirme
-- expresamente en la vista previa).
--
-- ADITIVA: una tabla nueva vacía. No modifica filas existentes. Sin datos de la
-- contraparte: la identidad del comprobante se guarda como huella SHA-256 de la
-- misma clave de duplicidad que usa la importación (lib/libro-iva-import/build.ts,
-- voucherKey), más tipo, punto de venta y número para el mensaje.
--
-- Eliminar el comprobante de la aplicación NO lo anula en ARCA.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateTable
CREATE TABLE "InvoiceImportDeletion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "keyHash" CHAR(64) NOT NULL,
    "voucherCode" INTEGER NOT NULL,
    "pointOfSale" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "periodId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedById" UUID,

    CONSTRAINT "InvoiceImportDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceImportDeletion_organizationId_clientId_keyHash_key" ON "InvoiceImportDeletion"("organizationId", "clientId", "keyHash");

-- CreateIndex
CREATE INDEX "InvoiceImportDeletion_clientId_organizationId_idx" ON "InvoiceImportDeletion"("clientId", "organizationId");

ALTER TABLE "InvoiceImportDeletion" ADD CONSTRAINT "InvoiceImportDeletion_state_check" CHECK (
    "category" IN ('SALES', 'PURCHASES')
    AND "keyHash" ~ '^[0-9a-f]{64}$'
    AND "pointOfSale" >= 0 AND "number" >= 1
);

-- AddForeignKey
ALTER TABLE "InvoiceImportDeletion" ADD CONSTRAINT "InvoiceImportDeletion_clientId_organizationId_fkey" FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceImportDeletion" ADD CONSTRAINT "InvoiceImportDeletion_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tabla nueva: sólo la usa el servidor (Prisma, rol propietario). RLS sin
-- políticas y sin privilegios para PUBLIC ni para los roles de la API de
-- Supabase (mismo criterio que 20261107120000_vat_export_close_versions).
DO $tables$
DECLARE r TEXT;
BEGIN
 ALTER TABLE "InvoiceImportDeletion" ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON TABLE "InvoiceImportDeletion" FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE "InvoiceImportDeletion" FROM %I', r);
 END LOOP;
END
$tables$;

COMMIT;
