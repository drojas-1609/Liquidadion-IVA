-- Perfil contable del cliente y plan de cuentas (Fase C2a).
ALTER TABLE "Client"
    ADD COLUMN "chartModel" VARCHAR(20),
    ADD COLUMN "mipymeCategory" VARCHAR(20),
    ADD COLUMN "mipymeManufacturing" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "mipymeValidUntil" DATE;

ALTER TABLE "Client" ADD CONSTRAINT "Client_accounting_profile_check" CHECK (
    ("chartModel" IS NULL OR "chartModel" IN ('COMMERCIAL', 'SERVICES'))
    AND ("mipymeCategory" IS NULL OR "mipymeCategory" IN ('MICRO', 'PEQUENA', 'MEDIANA_T1', 'MEDIANA_T2'))
    AND ("mipymeValidUntil" IS NULL OR "mipymeCategory" IS NOT NULL)
);

CREATE TABLE "ChartAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "imputable" BOOLEAN NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "role" VARCHAR(40),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "updatedById" UUID,
    CONSTRAINT "ChartAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChartAccount_code_check" CHECK ("code" ~ '^[1-5](\.[0-9]{2}(\.[0-9]{2}\.[0-9]{2})?)?$'),
    CONSTRAINT "ChartAccount_imputable_check" CHECK ("imputable" = ("code" ~ '^[1-5]\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$')),
    CONSTRAINT "ChartAccount_role_check" CHECK ("role" IS NULL OR "imputable")
);

CREATE UNIQUE INDEX "ChartAccount_clientId_code_key" ON "ChartAccount"("clientId", "code");
CREATE UNIQUE INDEX "ChartAccount_clientId_role_key" ON "ChartAccount"("clientId", "role");
CREATE INDEX "ChartAccount_clientId_organizationId_idx" ON "ChartAccount"("clientId", "organizationId");
CREATE INDEX "ChartAccount_organizationId_idx" ON "ChartAccount"("organizationId");

ALTER TABLE "ChartAccount" ADD CONSTRAINT "ChartAccount_clientId_organizationId_fkey"
    FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChartAccount" ENABLE ROW LEVEL SECURITY;
