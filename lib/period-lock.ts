import "server-only";
import type { Prisma } from "@prisma/client";
import { NotFoundError } from "./auth/errors";

/**
 * Bloqueo de la fila Period (SELECT ... FOR UPDATE) dentro de una transacción
 * YA ABIERTA por el llamador.
 *
 * Se bloquea Period (no PeriodVatSettings ni las filas hijas) porque es la
 * única fila que existe siempre para el período: la configuración puede no
 * existir todavía y los comprobantes/retenciones pueden estar por crearse.
 *
 * El bloqueo dura hasta el fin de la transacción del llamador. La consulta es
 * parametrizada (tagged template de Prisma): nunca se concatena SQL.
 * Sin fila para (id, organización) -> el mismo 404 que los controles de acceso.
 */
export type PeriodLockTx = Pick<Prisma.TransactionClient, "$queryRaw">;

/** Implementación interna de `lockPeriodForWrite`: no se exporta. */
async function lockPeriodForUpdate(tx: PeriodLockTx, periodId: string, organizationId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Period"
        WHERE "id" = ${periodId} AND "organizationId" = ${organizationId}
        FOR UPDATE`;
    if (rows.length !== 1) throw new NotFoundError();
}

/**
 * ÚNICO punto de entrada para bloquear un período antes de modificar su
 * contenido (comprobantes y sus líneas, retenciones/percepciones,
 * configuración de IVA) o de eliminarlo. Toda escritura de ese contenido lo
 * llama como PRIMERA operación de su transacción. El futuro control de estado
 * del período (cerrado) se incorpora acá.
 *
 * Orden único de bloqueo dentro de una transacción:
 *   1. Period  — lockPeriodForWrite (una sola vez, un solo período)
 *   2. Invoice — lockInvoiceForUpdate (lib/invoice-lock), sólo edición/baja
 *   3. lecturas bajo el bloqueo, escrituras y, al final, AuditLog
 * Nunca se bloquea Period después de Invoice ni dos veces en la misma
 * transacción; nunca dos períodos en la misma transacción.
 */
export async function lockPeriodForWrite(tx: PeriodLockTx, periodId: string, organizationId: string): Promise<void> {
    await lockPeriodForUpdate(tx, periodId, organizationId);
}
