import "server-only";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole } from "@/lib/auth/authz";
import { ROLES_USER_MANAGE } from "@/lib/auth/roles";
import { getSafeRedirectOrigin } from "@/lib/auth/origin";
import type { UsersActor } from "@/lib/users/service";

/**
 * Configuración → Usuarios: SÓLO el propietario de la organización activa.
 * Se relee la Membership en cada solicitud (sesión abierta no alcanza).
 * Orden: 401/503 -> 403 NO_PROFILE -> 403 NO_ORGANIZATION / 409 -> 403 FORBIDDEN.
 */
export async function requireUsersManager(): Promise<UsersActor> {
  const { profileId } = await requireAuthenticatedProfile();
  const { organizationId } = await resolveActiveOrganization(profileId);
  await requireOrganizationRole(profileId, organizationId, ROLES_USER_MANAGE);
  return { profileId, organizationId };
}

/** Destino del enlace del correo: origen VALIDADO del entorno, nunca uno del cliente. */
export function acceptInviteRedirect(request: Request): string {
  return `${getSafeRedirectOrigin(request)}/auth/accept-invite`;
}
