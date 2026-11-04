import "server-only";
import type { Prisma } from "@prisma/client";
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

/** Bloquea la fila del estudio. null si no existe. */
export async function lockOrganization(tx: SeatTx, organizationId: string): Promise<{ seatLimit: number } | null> {
  const rows = await tx.$queryRaw<{ seatLimit: number }[]>`
    SELECT "seatLimit" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
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
