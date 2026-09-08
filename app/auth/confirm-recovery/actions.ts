"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigError } from "@/lib/supabase/env";
import { getSafeRedirectOrigin, sanitizeNext } from "@/lib/auth/origin";
import { isWellFormedTokenHash } from "@/lib/auth/token-hash";

export interface ConfirmRecoveryState {
  error: string | null;
}

const GENERIC_INVALID =
  "El enlace de recuperación no es válido, ya fue usado o expiró. Pedí uno nuevo.";
const GENERIC_UNAVAILABLE = "El servicio de autenticación no está disponible en este momento.";

/**
 * POST EXPLÍCITO del botón "Confirmar recuperación de contraseña".
 *
 * Sólo acá se llama a `verifyOtp` (que consume el token de un solo uso). Un GET
 * de un escáner de enlaces no dispara esto. No depende de la cookie PKCE del
 * `resetPasswordForEmail`: `verifyOtp({ token_hash, type: "recovery" })` valida
 * el `token_hash` del enlace del lado del servidor y establece la sesión.
 *
 * CSRF: es una Server Action de Next 16 — sólo se invoca por POST con el
 * encoding de acción y validación `Origin`/`Host`; las cookies son
 * `SameSite=Lax`. Nunca se registra ni se devuelve el `token_hash` ni el
 * mensaje interno de Supabase.
 */
export async function confirmRecoveryAction(
  _prev: ConfirmRecoveryState,
  formData: FormData,
): Promise<ConfirmRecoveryState> {
  const tokenHash = formData.get("token_hash");
  const type = formData.get("type");
  const next = sanitizeNext(
    typeof formData.get("next") === "string" ? (formData.get("next") as string) : null,
    "/update-password",
  );

  if (type !== "recovery" || !isWellFormedTokenHash(tokenHash)) {
    return { error: GENERIC_INVALID };
  }

  let ok = false;
  try {
    const supabase = await getSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "recovery",
    });
    ok = !error;
  } catch (err) {
    if (isSupabaseConfigError(err)) {
      return { error: GENERIC_UNAVAILABLE };
    }
    return { error: GENERIC_INVALID };
  }

  if (!ok) {
    return { error: GENERIC_INVALID };
  }

  // Sesión establecida por verifyOtp. Redirección ABSOLUTA dentro del origen
  // validado del entorno (mismo helper que logout/callback) + path interno.
  const origin = getSafeRedirectOrigin({ headers: await headers() });
  redirect(`${origin}${sanitizeNext(next, "/update-password")}`);
}
