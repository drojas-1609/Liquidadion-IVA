import "server-only";
import { Prisma, type PeriodStatus } from "@prisma/client";
import { NotFoundError, PeriodBusyError, PeriodClosedError } from "./auth/errors";

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
 * (`set_config(..., true)`), activo SÓLO durante el FOR UPDATE del Period.
 *
 * Presupuesto de la transacción: cada writer inventariado declara
 * LITERALMENTE `{ maxWait: 5000, timeout: 10000 }` en su transacción interactiva
 * (lo exige tests/_period-lock-structure.ts): hasta 5000 ms para obtener la
 * transacción y 10000 ms en total. Así, aun esperando los 3000 ms del bloqueo,
 * quedan unos 7000 ms para el resto de la operación, y la contención se
 * informa (PERIOD_BUSY) antes de que venza la transacción. Vencido el timeout
 * de Prisma (P2028) sigue siendo un 500 genérico. Antes se lee el
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

/**
 * Fila bloqueada: el estado viaja como texto (`::text`) para no depender de
 * cómo deserializa el driver un enum de PostgreSQL en una consulta cruda.
 */
type LockedPeriodRow = { id: string; status: string };

/**
 * Implementación interna de `lockPeriodForWrite` y `lockPeriodForStatusChange`:
 * no se exporta. Devuelve el estado del período leído BAJO el bloqueo.
 */
async function lockPeriodForUpdate(tx: PeriodLockTx, periodId: string, organizationId: string): Promise<string> {
    const previousLockTimeout = await currentLockTimeout(tx);
    await tx.$queryRaw`SELECT set_config('lock_timeout', '3000ms', true)`;
    let rows: LockedPeriodRow[];
    try {
        rows = await tx.$queryRaw<LockedPeriodRow[]>`
            SELECT "id", "status"::text AS "status" FROM "Period"
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
    return rows[0].status;
}

/**
 * ÚNICO punto de entrada para bloquear un período antes de modificar su
 * contenido (comprobantes y sus líneas, retenciones/percepciones,
 * configuración de IVA) o de eliminarlo. Toda escritura de ese contenido lo
 * llama como PRIMERA operación de su transacción.
 *
 * Cierre del período: el estado se lee en el MISMO `SELECT … FOR UPDATE`. Si
 * no es OPEN (cerrado o cualquier valor desconocido: falla cerrada) ->
 * PeriodClosedError (409 PERIOD_CLOSED) antes de cualquier lectura, escritura
 * o AuditLog del llamador; la transacción hace rollback. Como cerrar y reabrir
 * toman este mismo bloqueo (`lockPeriodForStatusChange`), una escritura y un
 * cambio de estado del mismo período nunca se intercalan: la escritura que
 * espera a un cierre ve CLOSED y se rechaza; el cierre que espera a una
 * escritura se aplica después de que ésta confirme.
 *
 * El cierre NO congela la liquidación: se sigue calculando con la alícuota
 * IIBB vigente del cliente (Client.defaultIibbRate), que no es contenido del
 * período.
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
    const status = await lockPeriodForUpdate(tx, periodId, organizationId);
    if (status !== "OPEN") throw new PeriodClosedError();
}

/**
 * ÚNICO punto de entrada para bloquear un período antes de CAMBIAR SU ESTADO
 * (cerrar / reabrir). Mismo bloqueo, misma espera acotada y mismos errores
 * (404, 409 PERIOD_BUSY) que `lockPeriodForWrite`, pero NO rechaza un período
 * cerrado: devuelve el estado leído bajo el bloqueo para que la transición lo
 * evalúe. Sólo lo usan los handlers de transición inventariados
 * (tests/_period-lock-structure.ts), que no escriben el contenido del período.
 * Un estado desconocido es un error interno (500), nunca una transición.
 */
export async function lockPeriodForStatusChange(
    tx: PeriodLockTx,
    periodId: string,
    organizationId: string,
): Promise<PeriodStatus> {
    const status = await lockPeriodForUpdate(tx, periodId, organizationId);
    if (status !== "OPEN" && status !== "CLOSED") {
        throw new Error("lockPeriodForStatusChange: estado de período desconocido");
    }
    return status;
}
