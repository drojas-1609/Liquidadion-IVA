-- Ficha del cliente: contactos, inscripción IIBB, jurisdicciones, actividades y
-- alícuotas informativas. Migración EXPAND (aditiva).
--
-- Se apila DESPUÉS de 20261009120000_period_close_reopen y NO modifica
-- migraciones anteriores ni borra objetos.
--
-- COMPATIBILIDAD
--   - "Client"."phone", "contactEmail" e "iibbRegistration": NULLABLE, sin
--     default. Los clientes existentes quedan SIN DATO (información pendiente):
--     no se infiere la inscripción IIBB ni se cargan contactos ficticios.
--   - Tablas nuevas vacías: no se crean actividades ni se distribuye
--     "defaultIibbRate", que sigue siendo la única alícuota del cálculo.
--
-- INTEGRIDAD
--   - FKs compuestas con "organizationId": una jurisdicción, actividad o
--     alícuota nunca puede apuntar a un cliente de otra organización, y una
--     alícuota sólo a una actividad y jurisdicción del MISMO cliente.
--   - Jurisdicciones: códigos de Convenio Multilateral 901 a 924.
--   - Alícuota NULL = sin informar (distinta de 0 explícito); si existe, entre
--     0 y 100 (mismo rango que defaultIibbRate).
--   - La sede única de Convenio Multilateral y la coherencia con la
--     inscripción se validan en la aplicación (lib/client-profile.ts).
--   - Borrar una jurisdicción borra en cascada sus alícuotas (y borrar un
--     cliente, toda su ficha). Nunca en silencio desde la aplicación: el
--     servidor exige la confirmación EXACTA de lo que se pierde, con la fila
--     del cliente bloqueada y la versión verificada.
--
-- TRANSACCIÓN Y LÍMITES
--   Todo en una transacción EXPLÍCITA; lock_timeout acota la espera de CADA
--   bloqueo (ALTER TABLE "Client") y statement_timeout CADA sentencia.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
CREATE TYPE "ClientIibbRegistration" AS ENUM ('LOCAL', 'SIMPLIFICADO', 'EXENTO', 'NO_INSCRIPTO', 'CONVENIO_MULTILATERAL');

-- CreateEnum
CREATE TYPE "ActivityNomenclator" AS ENUM ('ARCA', 'NAES', 'PROVINCIAL', 'OTRO');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "iibbRegistration" "ClientIibbRegistration",
ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "ClientJurisdiction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "jurisdictionCode" TEXT NOT NULL,
    "isHeadquarters" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientJurisdiction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientActivity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "nomenclator" "ActivityNomenclator" NOT NULL,
    "nomenclatorJurisdiction" TEXT NOT NULL DEFAULT '',
    "nomenclatorReference" TEXT,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientActivityRate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "jurisdictionCode" TEXT NOT NULL,
    "rate" DECIMAL(9,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientActivityRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientJurisdiction_organizationId_idx" ON "ClientJurisdiction"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientJurisdiction_clientId_jurisdictionCode_key" ON "ClientJurisdiction"("clientId", "jurisdictionCode");

-- CreateIndex
CREATE UNIQUE INDEX "ClientJurisdiction_clientId_organizationId_jurisdictionCode_key" ON "ClientJurisdiction"("clientId", "organizationId", "jurisdictionCode");

-- CreateIndex
CREATE INDEX "ClientActivity_organizationId_idx" ON "ClientActivity"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientActivity_clientId_nomenclator_nomenclatorJurisdiction_key" ON "ClientActivity"("clientId", "nomenclator", "nomenclatorJurisdiction", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ClientActivity_id_clientId_organizationId_key" ON "ClientActivity"("id", "clientId", "organizationId");

-- CreateIndex
CREATE INDEX "ClientActivityRate_clientId_idx" ON "ClientActivityRate"("clientId");

-- CreateIndex
CREATE INDEX "ClientActivityRate_organizationId_idx" ON "ClientActivityRate"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientActivityRate_activityId_jurisdictionCode_key" ON "ClientActivityRate"("activityId", "jurisdictionCode");

-- AddForeignKey
ALTER TABLE "ClientJurisdiction" ADD CONSTRAINT "ClientJurisdiction_clientId_organizationId_fkey" FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientActivity" ADD CONSTRAINT "ClientActivity_clientId_organizationId_fkey" FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "ClientActivityRate_activityId_clientId_organizationId_fkey" FOREIGN KEY ("activityId", "clientId", "organizationId") REFERENCES "ClientActivity"("id", "clientId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "ClientActivityRate_clientId_organizationId_jurisdictionCod_fkey" FOREIGN KEY ("clientId", "organizationId", "jurisdictionCode") REFERENCES "ClientJurisdiction"("clientId", "organizationId", "jurisdictionCode") ON DELETE CASCADE ON UPDATE NO ACTION;


-- AddCheckConstraint
ALTER TABLE "ClientJurisdiction" ADD CONSTRAINT "ClientJurisdiction_code_check" CHECK ("jurisdictionCode" ~ '^9(0[1-9]|1[0-9]|2[0-4])$');

-- AddCheckConstraint
ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "ClientActivityRate_code_check" CHECK ("jurisdictionCode" ~ '^9(0[1-9]|1[0-9]|2[0-4])$');

-- AddCheckConstraint
ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "ClientActivityRate_rate_check" CHECK ("rate" IS NULL OR ("rate" >= 0 AND "rate" <= 100));

-- AddCheckConstraint
ALTER TABLE "ClientActivity" ADD CONSTRAINT "ClientActivity_text_check" CHECK (btrim("code") <> '' AND btrim("description") <> '');

-- AddCheckConstraint
ALTER TABLE "ClientActivity" ADD CONSTRAINT "ClientActivity_nomenclator_jurisdiction_check" CHECK (
    ("nomenclator" = 'PROVINCIAL' AND "nomenclatorJurisdiction" ~ '^9(0[1-9]|1[0-9]|2[0-4])$')
    OR ("nomenclator" <> 'PROVINCIAL' AND "nomenclatorJurisdiction" = '')
);

COMMIT;
