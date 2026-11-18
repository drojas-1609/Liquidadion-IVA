BEGIN;
SET LOCAL lock_timeout = '5s';

-- Regla por proveedor para separar «Otros tributos» de las compras. Tabla nueva:
-- no cambia ningún registro existente.
CREATE TABLE "SupplierOtherTaxesRule" (
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "supplierCuit" CHAR(11) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierOtherTaxesRule_pkey" PRIMARY KEY ("organizationId", "clientId", "supplierCuit"),
    CONSTRAINT "SupplierOtherTaxesRule_kind_check" CHECK ("kind" IN ('IIBB_PERCEPTION', 'INTERNAL_TAXES', 'OTHER')),
    CONSTRAINT "SupplierOtherTaxesRule_clientId_organizationId_fkey"
        FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SupplierOtherTaxesRule_clientId_organizationId_idx" ON "SupplierOtherTaxesRule"("clientId", "organizationId");
ALTER TABLE "SupplierOtherTaxesRule" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "SupplierOtherTaxesRule" FROM PUBLIC;
COMMIT;
