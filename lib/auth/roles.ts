import type { Role } from "@prisma/client";

// ── Implementadas en 3B ────────────────────────────────────────────────────
export const ROLES_READ: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT", "OPERATOR", "VIEWER"];
export const ROLES_CREATE: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT", "OPERATOR"];
export const ROLES_CLIENT_CREATE: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT"];
/** Exportar liquidación: mismo alcance que leer. */
export const ROLES_EXPORT: readonly Role[] = ROLES_READ;

// ── Gestión de clientes (editar / eliminar) ────────────────────────────────
/**
 * Editar una ficha existente requiere permiso específico.
 * Eliminar un Client usa `ROLES_DELETE`.
 */
export const ROLES_CLIENT_MANAGE: readonly Role[] = ["OWNER", "ADMIN", "OPERATOR"];

// ── Cierre y reapertura de períodos ────────────────────────────────────────
export const ROLES_PERIOD_CLOSE: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT", "OPERATOR"];
/** Reabrir un período cerrado: sólo OWNER y ADMIN (más sensible que cerrar). */
export const ROLES_PERIOD_REOPEN: readonly Role[] = ["OWNER", "ADMIN"];

// ── Usuarios del estudio (Configuración → Usuarios) ────────────────────────
/**
 * Invitar, reenviar o revocar invitaciones, cambiar permisos y desactivar o
 * reactivar accesos: SÓLO el propietario en esta primera entrega (más estricto
 * que `ROLES_MEMBERS`, que queda reservada para una delegación futura).
 */
export const ROLES_USER_MANAGE: readonly Role[] = ["OWNER"];
/** Roles que se pueden asignar a otra persona. OWNER nunca se asigna ni se quita desde la app. */
export const ASSIGNABLE_ROLES: readonly Role[] = ["ADMIN", "ACCOUNTANT", "OPERATOR", "VIEWER"];

// ── Futuras (matriz preparada, sin implementar) ────────────────────────────
export const ROLES_UPDATE: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT", "OPERATOR"];
export const ROLES_DELETE: readonly Role[] = ["OWNER", "ADMIN"];
export const ROLES_IMPORT: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT", "OPERATOR"];
export const ROLES_MEMBERS: readonly Role[] = ["OWNER", "ADMIN"];
export const ROLES_ROLE_CHANGE: readonly Role[] = ["OWNER"];
export const ROLES_CONFIG: readonly Role[] = ["OWNER", "ADMIN"];
export const ROLES_AUDIT_READ: readonly Role[] = ["OWNER", "ADMIN"];
export const ROLES_ORG_DELETE: readonly Role[] = ["OWNER"];

/** `true` si `role` está en `allowed`. */
export function roleAllows(allowed: readonly Role[], role: Role): boolean {
  return allowed.includes(role);
}
