import type { AppModule, ClientScope, MembershipStatus, Role } from "@prisma/client";

/**
 * Permisos por usuaria del estudio (Configuración → Usuarios).
 *
 * Tres ejes independientes, todos aplicados en el servidor en cada solicitud:
 *  - Rol (OWNER / ADMIN / ACCOUNTANT / OPERATOR / VIEWER): QUÉ acciones (lib/auth/roles).
 *  - Alcance de clientes (ALL / SELECTED): SOBRE QUÉ clientes. Un cliente fuera
 *    del alcance responde igual que uno inexistente (404).
 *  - Módulos: EN QUÉ áreas implementadas.
 *
 * El OWNER tiene siempre alcance y módulos completos: sus columnas no lo
 * restringen y no se pueden editar (protección del propietario).
 *
 * Archivo sin `server-only`: lo usa también la UI para rótulos.
 */

/** Módulos implementados, en orden de presentación. */
export const APP_MODULES: readonly AppModule[] = ["CLIENTS", "IVA", "ARCA_PADRON"];

export const MODULE_LABELS: Record<AppModule, { label: string; description: string }> = {
  CLIENTS: {
    label: "Fichas de clientes",
    description: "Alta, edición y baja de clientes; catálogos de actividades y sugerencia de alícuotas IIBB.",
  },
  IVA: {
    label: "Liquidación de IVA",
    description: "Períodos, comprobantes, retenciones y percepciones, liquidación y exportación a Excel.",
  },
  ARCA_PADRON: {
    label: "Consulta al padrón de ARCA",
    description: "Consulta de CUIT en ARCA para proponer datos del cliente y su registro de consultas.",
  },
};

/**
 * Listado y tablero de clientes: basta con CUALQUIERA de los módulos que
 * trabajan sobre clientes. El tablero muestra los períodos sólo con IVA.
 */
export const MODULES_CLIENT_DIRECTORY: readonly AppModule[] = ["CLIENTS", "IVA"];

/** Requisito de módulo: uno, o "cualquiera de" una lista. */
export type ModuleRequirement = AppModule | readonly AppModule[];

export const SCOPE_LABELS: Record<ClientScope, string> = {
  ALL: "Todos los clientes del estudio",
  SELECTED: "Clientes seleccionados",
};

export const ROLE_LABELS: Record<Role, { label: string; description: string }> = {
  OWNER: { label: "Propietario", description: "Acceso completo y gestión de usuarios." },
  ADMIN: { label: "Administración", description: "Carga, corrige, elimina y reabre; edita fichas de clientes." },
  OPERATOR: { label: "Operador", description: "Actualiza fichas existentes y opera los períodos y comprobantes de los clientes asignados." },
  ACCOUNTANT: { label: "Contable", description: "Carga y corrige comprobantes, retenciones y períodos." },
  VIEWER: { label: "Consulta", description: "Sólo lectura y exportación." },
};

export const STATUS_LABELS: Record<MembershipStatus, string> = {
  ACTIVE: "Activa",
  DISABLED: "Desactivada",
};

export interface MembershipPermissionsRow {
  role: Role;
  status: MembershipStatus;
  clientScope: ClientScope;
  modules: readonly AppModule[] | null;
}

export interface EffectivePermissions {
  role: Role;
  clientScope: ClientScope;
  modules: readonly AppModule[];
}

function isAppModule(value: unknown): value is AppModule {
  return typeof value === "string" && (APP_MODULES as readonly string[]).includes(value);
}

/**
 * Permisos efectivos de una membresía ACTIVA. OWNER: todo. Resto: lo guardado,
 * descartando valores desconocidos (fail-closed). Alcance desconocido -> SELECTED
 * (sin clientes asignados no ve ninguno).
 */
export function effectivePermissions(m: MembershipPermissionsRow): EffectivePermissions {
  if (m.role === "OWNER") return { role: m.role, clientScope: "ALL", modules: APP_MODULES };
  const modules = APP_MODULES.filter((x) => (m.modules ?? []).some((y) => y === x && isAppModule(y)));
  const clientScope: ClientScope = m.clientScope === "ALL" ? "ALL" : "SELECTED";
  return { role: m.role, clientScope, modules };
}

/** `true` si `modules` cumple el requisito (uno o cualquiera de la lista). */
export function modulesAllow(modules: readonly AppModule[], required: ModuleRequirement): boolean {
  const any: readonly AppModule[] = typeof required === "string" ? [required] : required;
  return any.some((m) => modules.includes(m));
}
