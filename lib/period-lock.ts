import "server-only";
import { Prisma } from "@prisma/client";
import { NotFoundError, PeriodBusyError } from "./auth/errors";

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
 *
 * Espera acotada: `lock_timeout` de 3000 ms, local a la transacción
 * (`set_config(..., true)`), activo SÓLO durante el FOR UPDATE del Period. Es
 * menor que el timeout de la transacción interactiva de Prisma (5000 ms), así
 * la contención se informa antes de que venza la transacción. Antes se lee el
 * valor vigente y, adquirido el bloqueo, se restaura exactamente ese valor: el
 * límite no alcanza al bloqueo de Invoice, a los índices únicos ni a las
 * escrituras posteriores.
 */
export type PeriodLockTx = Pick<Prisma.TransactionClient, "$queryRaw">;

/** SQLSTATE lock_not_available: venció `lock_timeout` esperando el bloqueo. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Error de Prisma de un `$queryRaw` que falló por `lock_timeout` (P2010 con el
 * SQLSTATE en `meta.code`). Cualquier otro error (P2028, P2034, deadlock,
 * statement_timeout, ...) NO se reconoce.
 */
function isLockNotAvailable(err: unknown): boolean {
    return (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2010" &&
        err.meta?.code === LOCK_NOT_AVAILABLE
    );
}

/** `lock_timeout` vigente en la transacción, para restaurarlo tras el bloqueo. */
async function currentLockTimeout(tx: PeriodLockTx): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ lockTimeout: unknown }>>`
        SELECT current_setting('lock_timeout') AS "lockTimeout"`;
    const value = rows.length === 1 ? rows[0].lockTimeout : undefined;
    if (typeof value !== "string" || value === "") {
        throw new Error("lockPeriodForWrite: no se pudo leer el lock_timeout vigente");
    }
    return value;
}

/** Implementación interna de `lockPeriodForWrite`: no se exporta. */
async function lockPeriodForUpdate(tx: PeriodLockTx, periodId: string, organizationId: string): Promise<void> {
    const previousLockTimeout = await currentLockTimeout(tx);
    await tx.$queryRaw`SELECT set_config('lock_timeout', '3000ms', true)`;
    let rows: Array<{ id: string }>;
    try {
        rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Period"
            WHERE "id" = ${periodId} AND "organizationId" = ${organizationId}
            FOR UPDATE`;
    } catch (err) {
        // La transacción quedó abortada: no se emite ninguna otra consulta.
        // El rollback del llamador descarta la configuración local.
        if (isLockNotAvailable(err)) throw new PeriodBusyError();
        throw err;
    }
    // Restauración parametrizada del valor previo (nunca concatenado al SQL).
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${previousLockTimeout}, true)`;
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
 *
 * Período bloqueado por otra escritura más de 3000 ms -> PeriodBusyError
 * (409 PERIOD_BUSY).
 */
export async function lockPeriodForWrite(tx: PeriodLockTx, periodId: string, organizationId: string): Promise<void> {
    await lockPeriodForUpdate(tx, periodId, organizationId);
}
