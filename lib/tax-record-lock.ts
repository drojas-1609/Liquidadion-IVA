import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Fila de TaxRecord BLOQUEADA (`SELECT … FOR UPDATE`) dentro de la transacción
 * de una edición o baja. Sólo las columnas que usan la revalidación (stale,
 * período, organización), `changedFields` y la auditoría.
 *
 * Orden de bloqueo obligatorio: SIEMPRE `lockPeriodForWrite` (lib/period-lock)
 * ANTES que este helper. No abre transacciones ni traduce errores: recibe el
 * `tx` de la ruta y deja que la ruta decida el 404.
 */
export interface LockedTaxRecordRow {
    id: string;
    organizationId: string;
    periodId: string;
    /** Puede ser un tipo histórico fuera del catálogo (lib/tax-types). */
    type: string;
    date: Date;
    amount: Prisma.Decimal;
    description: string | null;
    updatedAt: Date;
}

export type TaxRecordLockTx = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Bloquea la fila por id y organización con un tagged template parametrizado
 * (nunca `$queryRawUnsafe` ni concatenación). null si no existe en esa
 * organización.
 */
export async function lockTaxRecordForUpdate(
    tx: TaxRecordLockTx,
    taxRecordId: string,
    organizationId: string,
): Promise<LockedTaxRecordRow | null> {
    const rows = await tx.$queryRaw<LockedTaxRecordRow[]>`
        SELECT "id", "organizationId", "periodId", "type", "date", "amount", "description", "updatedAt"
        FROM "TaxRecord"
        WHERE "id" = ${taxRecordId} AND "organizationId" = ${organizationId}
        FOR UPDATE`;
    return rows.length === 1 ? rows[0] : null;
}
