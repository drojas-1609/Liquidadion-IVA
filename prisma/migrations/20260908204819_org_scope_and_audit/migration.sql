-- Tarea 3B — Autorización por organización + AuditLog + defensa de base de datos.
--
-- Generada offline con `prisma migrate diff --from-schema-datamodel ... --script`
-- y editada a mano para:
--   1. añadir `organizationId` como columna NULLABLE primero, hacer el BACKFILL
--      desde la relación padre y recién entonces `SET NOT NULL` (seguro también
--      sobre tablas con datos; no-op sobre las tablas vacías de dev);
--   2. ordenar en fases explícitas (drop FKs viejas -> columnas -> backfill ->
--      not null -> tabla nueva -> índices -> FKs compuestas).
--
-- Se apila DESPUÉS de:
--   0_init
--   20260907213357_float_to_decimal
--   20260908021123_org_auth_base
-- y NO modifica ninguna de ellas.
--
-- NO referencia el esquema `auth`, NO crea triggers ni funciones, NO altera
-- tipos Decimal (Tarea 2). El único DML es el backfill de `organizationId`.
--
-- Esta migración NO se aplica a producción en esta etapa.

-- ─────────────────────────────────────────────────────────────
-- Fase 1: quitar las FK simples (se reemplazan por FK compuestas).
-- ─────────────────────────────────────────────────────────────

-- DropForeignKey
ALTER TABLE "Period" DROP CONSTRAINT "Period_clientId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_periodId_fkey";

-- DropForeignKey
ALTER TABLE "TaxRecord" DROP CONSTRAINT "TaxRecord_periodId_fkey";

-- ─────────────────────────────────────────────────────────────
-- Fase 2: agregar `organizationId` como NULLABLE.
-- ─────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "Period" ADD COLUMN "organizationId" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "organizationId" TEXT;

-- AlterTable
ALTER TABLE "TaxRecord" ADD COLUMN "organizationId" TEXT;

-- ─────────────────────────────────────────────────────────────
-- Fase 3: BACKFILL desde la relación padre.
--   Period    <- Client.organizationId
--   Invoice   <- Period.organizationId (ya backfilleado)
--   TaxRecord <- Period.organizationId (ya backfilleado)
-- No-op sobre tablas vacías; correcto sobre tablas con datos.
-- ─────────────────────────────────────────────────────────────

UPDATE "Period" AS p
SET "organizationId" = c."organizationId"
FROM "Client" AS c
WHERE c."id" = p."clientId";

UPDATE "Invoice" AS i
SET "organizationId" = pe."organizationId"
FROM "Period" AS pe
WHERE pe."id" = i."periodId";

UPDATE "TaxRecord" AS t
SET "organizationId" = pe."organizationId"
FROM "Period" AS pe
WHERE pe."id" = t."periodId";

-- ─────────────────────────────────────────────────────────────
-- Fase 4: forzar NOT NULL una vez backfilleado.
-- ─────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "Period" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Invoice" ALTER COLUMN "organizationId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TaxRecord" ALTER COLUMN "organizationId" SET NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- Fase 5: tabla de auditoría.
-- ─────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorProfileId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────
-- Fase 6: índices.
--   - UNIQUE (id, organizationId) en Client y Period: destino de FK compuesta.
--   - Índices EXPLÍCITOS de las columnas hijas de cada FK compuesta
--     (PostgreSQL/Prisma NO los crean solos).
--   - Índices por organizationId para el scope de consultas.
--   Los índices simples previos (Period_clientId_idx, Invoice_periodId_idx,
--   TaxRecord_periodId_idx) se CONSERVAN; se retirarán en una migración
--   posterior sólo tras confirmar en dev (EXPLAIN / pg_indexes) que el índice
--   compuesto cubre el filtro por su primer campo.
-- ─────────────────────────────────────────────────────────────

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_id_organizationId_key" ON "Client"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Period_id_organizationId_key" ON "Period"("id", "organizationId");

-- CreateIndex
CREATE INDEX "Period_clientId_organizationId_idx" ON "Period"("clientId", "organizationId");

-- CreateIndex
CREATE INDEX "Period_organizationId_idx" ON "Period"("organizationId");

-- CreateIndex
CREATE INDEX "Invoice_periodId_organizationId_idx" ON "Invoice"("periodId", "organizationId");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_idx" ON "Invoice"("organizationId");

-- CreateIndex
CREATE INDEX "TaxRecord_periodId_organizationId_idx" ON "TaxRecord"("periodId", "organizationId");

-- CreateIndex
CREATE INDEX "TaxRecord_organizationId_idx" ON "TaxRecord"("organizationId");

-- ─────────────────────────────────────────────────────────────
-- Fase 7: FKs compuestas (impiden relaciones entre organizaciones distintas)
--         + FKs de AuditLog.
--   AuditLog.organization -> ON DELETE RESTRICT (el historial NO se borra en
--   cascada al eliminar una Organization; requiere política de conservación
--   antes de habilitar esa eliminación, hoy fuera de alcance).
--   AuditLog.actor        -> ON DELETE SET NULL.
-- ─────────────────────────────────────────────────────────────

-- AddForeignKey
ALTER TABLE "Period" ADD CONSTRAINT "Period_clientId_organizationId_fkey" FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_periodId_organizationId_fkey" FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRecord" ADD CONSTRAINT "TaxRecord_periodId_organizationId_fkey" FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorProfileId_fkey" FOREIGN KEY ("actorProfileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
