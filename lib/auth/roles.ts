import type { Role } from "@prisma/client";

/**
 * Matriz de roles de la Tarea 3B (aprobada).
 *
 * Enum real: OWNER, ADMIN, ACCOUNTANT, VIEWER. No se inventan roles.
 *
 * Sólo `ROLES_READ`, `ROLES_CREATE` y `ROLES_EXPORT` se usan en 3B. El resto
 * queda declarado y testeado (tests/auth/roles.test.ts) para que las funciones
 * futuras (update/delete/import, administración de miembros, cambio de roles,
 * configuración, lectura de auditoría, eliminación de organización) se conecten
 * a la constante correcta desde el primer día.
 */

// ── Implementadas en 3B ────────────────────────────────────────────────────
export const ROLES_READ: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"];
export const ROLES_CREATE: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT"];
/** Exportar liquidación: mismo alcance que leer. */
export const ROLES_EXPORT: readonly Role[] = ROLES_READ;

// ── Futuras (matriz preparada, sin implementar) ────────────────────────────
export const ROLES_UPDATE: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT"];
export const ROLES_DELETE: readonly Role[] = ["OWNER", "ADMIN"];
export const ROLES_IMPORT: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT"];
export const ROLES_MEMBERS: readonly Role[] = ["OWNER", "ADMIN"];
export const ROLES_ROLE_CHANGE: readonly Role[] = ["OWNER"];
export const ROLES_CONFIG: readonly Role[] = ["OWNER", "ADMIN"];
export const ROLES_AUDIT_READ: readonly Role[] = ["OWNER", "ADMIN"];
export const ROLES_ORG_DELETE: readonly Role[] = ["OWNER"];

/** `true` si `role` está en `allowed`. */
export function roleAllows(allowed: readonly Role[], role: Role): boolean {
  return allowed.includes(role);
}
