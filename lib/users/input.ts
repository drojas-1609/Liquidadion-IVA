import type { AppModule, ClientScope, Role } from "@prisma/client";
import { APP_MODULES } from "@/lib/auth/permissions";
import { ASSIGNABLE_ROLES } from "@/lib/auth/roles";

/**
 * Validación de los cuerpos de Configuración → Usuarios. Pura (sin base): la
 * pertenencia de los clientes al estudio se verifica en el servicio.
 *
 * Cualquier campo desconocido se ignora; organizationId, status, OWNER y
 * similares nunca se toman del cuerpo.
 */

export type InputResult<T> = { ok: true; data: T } | { ok: false; error: string; field: string };

export interface PermissionsInput {
  role: Role;
  clientScope: ClientScope;
  /** Únicos, en el orden recibido. Vacío si clientScope = ALL. */
  clientIds: string[];
  /** Subconjunto no vacío de APP_MODULES, en orden canónico. */
  modules: AppModule[];
}

export interface InviteInput extends PermissionsInput {
  email: string;
}

export const MAX_SELECTED_CLIENTS = 1000;
const MAX_EMAIL = 254;
// Forma razonable de correo: algo@dominio.tld, sin espacios ni comillas.
const EMAIL_RE = /^[^\s@"'<>(),;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** trim + minúsculas. La identidad sigue siendo auth.users.id; esto sólo ubica la invitación. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length === 0 || e.length > MAX_EMAIL || !EMAIL_RE.test(e)) return null;
  return e;
}

function fail(error: string, field: string): { ok: false; error: string; field: string } {
  return { ok: false, error, field };
}

export function parsePermissions(body: unknown): InputResult<PermissionsInput> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return fail("Cuerpo inválido.", "body");
  const b = body as Record<string, unknown>;

  if (typeof b.role !== "string" || !(ASSIGNABLE_ROLES as readonly string[]).includes(b.role)) {
    return fail("Elegí un rol válido (Administración, Contable o Consulta).", "role");
  }
  const role = b.role as Role;

  if (b.clientScope !== "ALL" && b.clientScope !== "SELECTED") {
    return fail("Elegí el alcance de clientes.", "clientScope");
  }
  const clientScope = b.clientScope as ClientScope;

  let clientIds: string[] = [];
  if (clientScope === "SELECTED") {
    if (!Array.isArray(b.clientIds)) return fail("Elegí al menos un cliente.", "clientIds");
    const seen = new Set<string>();
    for (const id of b.clientIds) {
      if (typeof id !== "string" || !ID_RE.test(id)) return fail("Hay un cliente inválido en la selección.", "clientIds");
      seen.add(id);
    }
    clientIds = [...seen];
    if (clientIds.length === 0) return fail("Elegí al menos un cliente.", "clientIds");
    if (clientIds.length > MAX_SELECTED_CLIENTS) return fail("Demasiados clientes seleccionados.", "clientIds");
  }

  if (!Array.isArray(b.modules)) return fail("Elegí al menos un módulo.", "modules");
  for (const m of b.modules) {
    if (typeof m !== "string" || !(APP_MODULES as readonly string[]).includes(m)) {
      return fail("Hay un módulo inválido en la selección.", "modules");
    }
  }
  const modules = APP_MODULES.filter((m) => (b.modules as unknown[]).includes(m));
  if (modules.length === 0) return fail("Elegí al menos un módulo.", "modules");

  return { ok: true, data: { role, clientScope, clientIds, modules } };
}

export function parseInvite(body: unknown): InputResult<InviteInput> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return fail("Cuerpo inválido.", "body");
  const email = normalizeEmail((body as Record<string, unknown>).email);
  if (!email) return fail("Ingresá un correo electrónico válido.", "email");
  const perms = parsePermissions(body);
  if (!perms.ok) return perms;
  return { ok: true, data: { email, ...perms.data } };
}
