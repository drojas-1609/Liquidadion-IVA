"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigError } from "@/lib/supabase/env";
import { getAuthClaims } from "@/lib/auth/claims";
import { isAuthError } from "@/lib/auth/errors";
import { getSafeRedirectOrigin } from "@/lib/auth/origin";
import { isWellFormedTokenHash } from "@/lib/auth/token-hash";
import { acceptInvitation, hasAcceptableInvitation } from "@/lib/users/service";

export interface AcceptInviteState {
  error: string | null;
}

const MIN_LENGTH = 12;
const INVALID_LINK = "El enlace no es válido, ya fue usado o expiró. Pedile al estudio que te reenvíe la invitación.";
const UNAVAILABLE = "El servicio de autenticación no está disponible en este momento.";
const NO_INVITATION = "No encontramos una invitación vigente para esta cuenta. Pedile al estudio que te la reenvíe.";

/**
 * POST explícito de "Activar acceso".
 *
 * 1. Valida forma del enlace y, si es cuenta nueva, la contraseña (antes de
 *    consumir el token de un solo uso).
 * 2. `verifyOtp` establece la sesión de la persona invitada. Si el token ya se
 *    consumió (reintento), se usa la sesión vigente SÓLO si su correo
 *    verificado tiene una invitación vigente.
 * 2b. Exige correo confirmado según Auth (getUser), con el mismo id que la sesión.
 * 3. Verifica que haya invitación para ESA identidad antes de tocar la
 *    contraseña (nunca se cambia la contraseña de otra cuenta abierta en el
 *    mismo navegador).
 * 4. Define la contraseña (cuenta nueva) y convierte la invitación en acceso
 *    (lib/users/service.acceptInvitation: bloqueo del estudio + auditoría).
 *
 * Nunca se registra ni se devuelve el token, la contraseña ni el mensaje de Supabase.
 */
export async function acceptInviteAction(_prev: AcceptInviteState, formData: FormData): Promise<AcceptInviteState> {
  const tokenHash = formData.get("token_hash");
  const type = formData.get("type");
  if ((type !== "invite" && type !== "magiclink") || !isWellFormedTokenHash(tokenHash)) {
    return { error: INVALID_LINK };
  }
  const newAccount = type === "invite";
  const password = String(formData.get("password") ?? "");
  if (newAccount) {
    if (password.length < MIN_LENGTH) return { error: `La contraseña debe tener al menos ${MIN_LENGTH} caracteres.` };
    if (password !== String(formData.get("confirm") ?? "")) return { error: "Las contraseñas no coinciden." };
  }

  let supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>;
  try {
    supabase = await getSupabaseServerClient();
  } catch (err) {
    if (isSupabaseConfigError(err)) return { error: UNAVAILABLE };
    return { error: INVALID_LINK };
  }

  try {
    await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  } catch {
    // Se evalúa abajo con la sesión que haya quedado.
  }

  let claims: Awaited<ReturnType<typeof getAuthClaims>>;
  try {
    claims = await getAuthClaims();
  } catch (err) {
    if (isSupabaseConfigError(err) || isAuthError(err)) return { error: UNAVAILABLE };
    return { error: INVALID_LINK };
  }
  if (!claims) return { error: INVALID_LINK };

  // La invitación se ubica por correo: sólo vale un correo CONFIRMADO, leído del
  // servidor de Auth (no del JWT). Abrir el enlace (invite/magiclink) lo
  // confirma; una cuenta con el correo sin verificar no toma la invitación.
  let verifiedEmail: string | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    const user = error ? null : data?.user;
    if (user && user.id === claims.sub && user.email_confirmed_at && typeof user.email === "string") {
      verifiedEmail = user.email;
    }
  } catch {
    return { error: UNAVAILABLE };
  }
  if (!verifiedEmail) return { error: INVALID_LINK };

  const identity = { sub: claims.sub, email: verifiedEmail };
  if (!(await hasAcceptableInvitation(identity))) return { error: NO_INVITATION };

  if (newAccount) {
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) return { error: "No se pudo guardar la contraseña. Probá con otra o pedí un enlace nuevo." };
    } catch {
      return { error: "No se pudo guardar la contraseña. Probá de nuevo." };
    }
  }

  try {
    await acceptInvitation(identity);
  } catch (err) {
    if (isAuthError(err) && err.status === 409) return { error: err.message };
    console.error("[accept-invite] error no clasificado:", err instanceof Error ? err.name : typeof err);
    return { error: "No se pudo activar el acceso. Probá de nuevo." };
  }

  const origin = getSafeRedirectOrigin({ headers: await headers() });
  redirect(`${origin}/`);
}
