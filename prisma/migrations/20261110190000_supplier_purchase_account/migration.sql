BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Invoice" ADD COLUMN "purchaseAccount" VARCHAR(120);
CREATE TABLE "SupplierPurchaseAccount" (
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "supplierCuit" CHAR(11) NOT NULL,
    "account" VARCHAR(120) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierPurchaseAccount_pkey" PRIMARY KEY ("organizationId", "clientId", "supplierCuit"),
    CONSTRAINT "SupplierPurchaseAccount_clientId_organizationId_fkey"
        FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SupplierPurchaseAccount_clientId_organizationId_idx" ON "SupplierPurchaseAccount"("clientId", "organizationId");
ALTER TABLE "SupplierPurchaseAccount" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "SupplierPurchaseAccount" FROM PUBLIC;
COMMIT;
