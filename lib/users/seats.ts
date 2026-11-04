import "server-only";
import { Prisma } from "@prisma/client";
import { AuthError } from "@/lib/auth/errors";
import type { SeatUsage } from "@/lib/users/views";

export type { SeatUsage };

/**
 * Cupo de plazas del estudio.
 *
 * OCUPAN PLAZA:
 *  - Membership con status ACTIVE (incluido el propietario);
 *  - OrganizationInvitation PENDING con expiresAt > ahora.
 * NO ocupan plaza: membresías DISABLED, invitaciones ACCEPTED (ya son una
 * Membership ACTIVE), REVOKED o vencidas.
 *
 * CONCURRENCIA: toda operación que pueda sumar una plaza (invitar, reenviar una
 * invitación vencida, reactivar un acceso) y toda aceptación toma primero
 * `lockOrganization` (SELECT ... FOR UPDATE de la fila Organization) dentro de
 * la misma transacción, y cuenta DESPUÉS del bloqueo. Dos invitaciones
 * simultáneas se serializan: la segunda ve la plaza que ocupó la primera.
 */

export const INVITATION_TTL_DAYS = 7;
export const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

type SeatTx = Pick<Prisma.TransactionClient, "$queryRaw" | "membership" | "organizationInvitation">;

export const ORGANIZATION_BUSY_MESSAGE =
  "El estudio está procesando otra operación de usuarios. Esperá unos segundos y volvé a intentarlo.";

/** SQLSTATE lock_not_available: venció `lock_timeout` esperando el bloqueo. */
function isLockNotAvailable(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2010" &&
    (err.meta as { code?: unknown } | undefined)?.code === "55P03"
  );
}

/**
 * Bloquea la fila del estudio (SELECT ... FOR UPDATE). null si no existe.
 *
 * Espera acotada (mismo criterio que lib/arca-padron/quota-store.ts):
 * `SET LOCAL lock_timeout = '3s'`, que vale hasta el fin de la transacción. Si
 * otra operación del mismo estudio retiene el bloqueo más de 3 s -> 409 field
 * "busy" (nunca un 500). Cada transacción de Configuración → Usuarios declara
 * LITERALMENTE `{ maxWait: 5000, timeout: 12000 }`: 3 s de espera + las
 * sentencias de la operación con latencia de red, antes de que venza (P2028).
 * Medido (smoke DEV 04/11/2026 y repro local con ~150 ms de ida y vuelta):
 * con los valores por defecto de Prisma (2000/5000), una de cuatro altas
 * simultáneas terminaba en 500.
 * Inventario exacto de este archivo: tests/_period-lock-structure.ts.
 */
export async function lockOrganization(tx: SeatTx, organizationId: string): Promise<{ seatLimit: number } | null> {
  await tx.$queryRaw`SET LOCAL lock_timeout = '3s'`;
  let rows: { seatLimit: number }[];
  try {
    rows = await tx.$queryRaw<{ seatLimit: number }[]>`
      SELECT "seatLimit" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
  } catch (err) {
    if (isLockNotAvailable(err)) throw new AuthError("CONFLICT", 409, ORGANIZATION_BUSY_MESSAGE, "busy");
    throw err;
  }
  return rows.length > 0 ? { seatLimit: Number(rows[0].seatLimit) } : null;
}

export async function countSeats(
  tx: Pick<SeatTx, "membership" | "organizationInvitation">,
  organizationId: string,
  limit: number,
  now: Date,
): Promise<SeatUsage> {
  const [active, pending] = await Promise.all([
    tx.membership.count({ where: { organizationId, status: "ACTIVE" } }),
    tx.organizationInvitation.count({ where: { organizationId, status: "PENDING", expiresAt: { gt: now } } }),
  ]);
  const used = active + pending;
  return { limit, active, pending, used, available: Math.max(0, limit - used) };
}
