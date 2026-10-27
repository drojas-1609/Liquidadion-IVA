import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Fila de Client BLOQUEADA (`SELECT … FOR UPDATE`) dentro de la transacción de
 * una edición (campos generales, contactos y ficha IIBB). Sólo lo que usa la
 * verificación de versión: `updatedAt` es el token de concurrencia optimista.
 *
 * No abre transacciones ni traduce errores: recibe el `tx` de la ruta y deja
 * que la ruta decida el 404 / 409.
 */
export interface LockedClientRow {
    id: string;
    organizationId: string;
    updatedAt: Date;
}

export type ClientLockTx = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Bloquea la fila por id y organización con un tagged template parametrizado
 * (nunca `$queryRawUnsafe` ni concatenación). null si no existe en esa
 * organización.
 */
export async function lockClientForUpdate(
    tx: ClientLockTx,
    clientId: string,
    organizationId: string,
): Promise<LockedClientRow | null> {
    const rows = await tx.$queryRaw<LockedClientRow[]>`
        SELECT "id", "organizationId", "updatedAt"
        FROM "Client"
        WHERE "id" = ${clientId} AND "organizationId" = ${organizationId}
        FOR UPDATE`;
    return rows.length === 1 ? rows[0] : null;
}

/**
 * Próxima versión: estrictamente posterior a la bloqueada aunque el reloj del
 * servidor esté atrasado o coincida en el mismo milisegundo (`updatedAt` se
 * guarda con precisión de milisegundos).
 */
export function nextClientVersion(locked: Date, nowMs: number): Date {
    return new Date(Math.max(nowMs, locked.getTime() + 1));
}
