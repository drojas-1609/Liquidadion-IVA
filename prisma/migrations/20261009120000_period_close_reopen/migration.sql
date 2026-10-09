-- Cierre y reapertura de períodos. Migración EXPAND (aditiva).
--
-- Se apila DESPUÉS de:
--   0_init
--   20260907213357_float_to_decimal
--   20260908021123_org_auth_base
--   20260908204819_org_scope_and_audit
--   20260925030000_invoice_accounting_model_expand
--   20260925210133_invoice_counterparty_turiva_variant_expand
-- y NO modifica ninguna de ellas ni borra sus objetos.
--
-- COMPATIBILIDAD
--   - "status" NOT NULL con DEFAULT 'OPEN': todos los períodos existentes
--     quedan ABIERTOS, sin backfill adicional ni cierre masivo. En PostgreSQL
--     11+ agregar una columna con DEFAULT constante no reescribe la tabla.
--   - "closedAt" y "closedById" NULLABLE, sin default: NULL en toda fila
--     existente.
--   - "closedById" es UUID, igual que "Profile"."id" (FK con ON DELETE SET
--     NULL, como createdById/updatedById: el historial sobrevive al Profile).
--
-- COHERENCIA
--   CHECK "Period_closed_state_check": status = 'CLOSED' si y sólo si
--   "closedAt" NO es NULL. Ambos operandos son NOT NULL como booleanos (status
--   es NOT NULL; IS NOT NULL nunca es NULL), así que el CHECK nunca evalúa a
--   NULL. Las filas existentes (OPEN, closedAt NULL) lo cumplen.
--   "closedById" NO integra el CHECK: puede quedar NULL en un período cerrado
--   si se elimina el Profile que lo cerró.
--
-- ALCANCE
--   El cierre bloquea en la aplicación (lib/period-lock) la modificación y la
--   eliminación del período y de su contenido. NO congela la liquidación: se
--   sigue calculando con Client.defaultIibbRate vigente.

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "Period" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedById" UUID,
ADD COLUMN     "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN';

-- AddForeignKey
ALTER TABLE "Period" ADD CONSTRAINT "Period_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "Period" ADD CONSTRAINT "Period_closed_state_check" CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL));
