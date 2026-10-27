-- Origen de actividades (catálogo oficial versionado o carga manual) y
-- tratamiento/origen de las alícuotas informativas. Migración EXPAND (aditiva).
--
-- Se apila DESPUÉS de 20261025120000_client_profile_iibb_contacts y NO modifica
-- migraciones anteriores ni borra objetos.
--
-- COMPATIBILIDAD
--   - Columnas nuevas con DEFAULT constante o NULLABLE: las filas existentes
--     quedan como actividades MANUAL y alícuotas RATE sin origen registrado. No
--     se transforma ningún dato (sin UPDATE).
--   - El código anterior ignora estas columnas: funciona con el esquema migrado.
--   - Nada de esto interviene en la liquidación (sigue usando defaultIibbRate).
--
-- INTEGRIDAD (CHECK)
--   - Actividad CATALOG: catalogId y catalogVersion obligatorios; MANUAL: ambos NULL.
--   - Exención: sin tasa (0 % explícito, exención y dato ausente son distintos).
--   - Sugerencia confirmada: ruleRef obligatorio; ruleRef sólo con ese origen.
--   - Dato ausente (RATE sin tasa): sin origen.
--
-- TRANSACCIÓN Y LÍMITES: transacción explícita; lock_timeout acota la espera de
-- cada bloqueo y statement_timeout cada sentencia.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
CREATE TYPE "ActivityOrigin" AS ENUM ('CATALOG', 'MANUAL');

-- CreateEnum
CREATE TYPE "RateTreatment" AS ENUM ('RATE', 'EXEMPT');

-- CreateEnum
CREATE TYPE "RateOrigin" AS ENUM ('STUDIO_MANUAL', 'CONFIRMED_SUGGESTION');

-- AlterTable
ALTER TABLE "ClientActivity" ADD COLUMN     "catalogId" TEXT,
ADD COLUMN     "catalogVersion" TEXT,
ADD COLUMN     "origin" "ActivityOrigin" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "ClientActivityRate" ADD COLUMN     "rateOrigin" "RateOrigin",
ADD COLUMN     "ruleRef" TEXT,
ADD COLUMN     "treatment" "RateTreatment" NOT NULL DEFAULT 'RATE';

-- AddCheckConstraint
ALTER TABLE "ClientActivity" ADD CONSTRAINT "ClientActivity_origin_catalog_check" CHECK (
    ("origin" = 'CATALOG' AND "catalogId" IS NOT NULL AND btrim("catalogId") <> '' AND "catalogVersion" IS NOT NULL AND btrim("catalogVersion") <> '')
    OR ("origin" = 'MANUAL' AND "catalogId" IS NULL AND "catalogVersion" IS NULL)
);

-- AddCheckConstraint
ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "ClientActivityRate_treatment_check" CHECK ("treatment" = 'RATE' OR "rate" IS NULL);

-- AddCheckConstraint
ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "ClientActivityRate_origin_check" CHECK (
    ("rateOrigin" IS NOT DISTINCT FROM 'CONFIRMED_SUGGESTION') = ("ruleRef" IS NOT NULL)
    AND NOT ("treatment" = 'RATE' AND "rate" IS NULL AND "rateOrigin" IS NOT NULL)
);

COMMIT;
