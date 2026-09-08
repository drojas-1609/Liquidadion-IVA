"use server";

import { headers } from "next/headers";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSafeRedirectOrigin } from "@/lib/auth/origin";

export interface ResetState {
  done: boolean;
}

/**
 * Pide el correo de recuperación. La respuesta es SIEMPRE genérica: no revela
 * si la dirección existe.
 *
 * `redirectTo` = `<origen-validado>/auth/confirm-recovery` — la página
 * intermedia anti-escáner. Supabase lo expone como `{{ .RedirectTo }}` en la
 * plantilla; el enlace del email agrega `?token_hash={{ .TokenHash }}&type=recovery`.
 * El origen se resuelve con `getSafeRedirectOrigin` (misma allow-list estricta
 * que logout y callback): el enlace apunta al MISMO entorno donde se pidió la
 * recuperación (Deploy Preview / producción / localhost), nunca a un host
 * aportado por encabezados sin validar. `getSafeRedirectOrigin` acepta
 * cualquier objeto con `headers.get(...)`, así que sirve para esta Server
 * Action sin `Request`.
 */
export async function requestResetAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const email = String(formData.get("email") ?? "").trim();

  if (email) {
    try {
      const supabase = await getSupabaseServerClient();
      const origin = getSafeRedirectOrigin({ headers: await headers() });
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/auth/confirm-recovery`,
      });
    } catch {
      // Silencioso a propósito: nada debe distinguir éxito de error.
    }
  }

  return { done: true };
}
