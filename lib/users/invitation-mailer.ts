import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicEnv } from "@/lib/supabase/env";

/**
 * Envío del correo de invitación a través de Supabase Auth.
 *
 * - Cuenta nueva: `auth.admin.inviteUserByEmail` (requiere la service_role, que
 *   SÓLO se lee acá, en el servidor, de SUPABASE_SERVICE_ROLE_KEY; nunca va al
 *   bundle ni a una respuesta). El correo usa la plantilla "Invite user" con
 *   `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite`.
 * - Cuenta ya existente en Auth: enlace de acceso por correo
 *   (`signInWithOtp`, shouldCreateUser: false) con la plantilla "Magic Link"
 *   `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink`.
 * Ver docs/usuarios/README.md.
 *
 * GUARDA DE DESTINATARIOS fuera de producción (CONTEXT !== "production"):
 * sólo se envía a direcciones de USER_INVITE_EMAIL_ALLOWLIST (lista separada
 * por comas; admite `*` como comodín, p. ej. `alguien+*@dominio.com`). Sin
 * lista -> no se envía (BLOCKED_RECIPIENT). Así DEV/Preview no pueden escribirle
 * a personas reales por error.
 *
 * Nunca se registra el correo, el enlace, el token ni el mensaje de Supabase.
 */

export type DeliveryResult =
  | { status: "SENT"; channel: "invite" | "magiclink"; authUserId: string | null }
  | { status: "NOT_CONFIGURED" }
  | { status: "BLOCKED_RECIPIENT" }
  | { status: "FAILED" };

export type DeliveryStatus = DeliveryResult["status"];

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^@\\s]*");
  return new RegExp(`^${escaped}$`, "i");
}

/** `true` si se puede enviar a `email` en este entorno. */
export function recipientAllowed(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CONTEXT === "production") return true;
  const list = (env.USER_INVITE_EMAIL_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return false;
  return list.some((entry) => globToRegExp(entry).test(email));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function alreadyRegistered(err: { status?: number; code?: string } | null): boolean {
  if (!err) return false;
  return err.code === "email_exists" || err.code === "user_already_exists";
}

export async function sendInvitationEmail(email: string, redirectTo: string): Promise<DeliveryResult> {
  if (!recipientAllowed(email)) return { status: "BLOCKED_RECIPIENT" };

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let url: string;
  let anonKey: string;
  try {
    ({ url, anonKey } = getSupabasePublicEnv());
  } catch {
    return { status: "NOT_CONFIGURED" };
  }
  if (!serviceKey || serviceKey.trim().length < 20) return { status: "NOT_CONFIGURED" };

  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  try {
    const admin = createClient(url, serviceKey, noSession);
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (!error) {
      const id = data?.user?.id;
      return { status: "SENT", channel: "invite", authUserId: typeof id === "string" && UUID_RE.test(id) ? id : null };
    }
    if (!alreadyRegistered(error as { status?: number; code?: string })) {
      console.warn("[invitation-mailer] invite failed", (error as { code?: string }).code ?? "unknown");
      return { status: "FAILED" };
    }
    const anon = createClient(url, anonKey, noSession);
    const otp = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
    if (otp.error) {
      console.warn("[invitation-mailer] magiclink failed", (otp.error as { code?: string }).code ?? "unknown");
      return { status: "FAILED" };
    }
    return { status: "SENT", channel: "magiclink", authUserId: null };
  } catch (err) {
    console.warn("[invitation-mailer] error", err instanceof Error ? err.name : typeof err);
    return { status: "FAILED" };
  }
}
