import "server-only";
import type { Prisma } from "@prisma/client";
import { NotFoundError } from "./auth/errors";

/**
 * Bloqueo de la fila Period (SELECT ... FOR UPDATE) dentro de una transacción
 * YA ABIERTA por el llamador.
 *
 * Serializa las operaciones que dependen de la configuración TurIVA del
 * período: el cambio de `PeriodVatSettings.turivaIncluded` y el alta de
 * comprobantes 195–197. Se bloquea Period (no PeriodVatSettings) porque la
 * fila de configuración puede no existir todavía.
 *
 * El bloqueo dura hasta el fin de la transacción del llamador. La consulta es
 * parametrizada (tagged template de Prisma): nunca se concatena SQL.
 * Sin fila para (id, organización) -> el mismo 404 que los controles de acceso.
 */
export type PeriodLockTx = Pick<Prisma.TransactionClient, "$queryRaw">;

export async function lockPeriodForUpdate(tx: PeriodLockTx, periodId: string, organizationId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Period"
        WHERE "id" = ${periodId} AND "organizationId" = ${organizationId}
        FOR UPDATE`;
    if (rows.length !== 1) throw new NotFoundError();
}
