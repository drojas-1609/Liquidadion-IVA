"use server";

import { headers } from "next/headers";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getTrustedOrigin } from "@/lib/auth/origin";

export interface ResetState {
  done: boolean;
}

/**
 * Pide el correo de recuperación. La respuesta es SIEMPRE genérica: no revela
 * si la dirección existe. El `redirectTo` se arma sobre un origen confiable y
 * apunta al callback, que luego lleva a /update-password.
 */
export async function requestResetAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const email = String(formData.get("email") ?? "").trim();

  if (email) {
    try {
      const supabase = await getSupabaseServerClient();
      const origin = getTrustedOrigin({ headers: await headers() });
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/auth/callback?next=%2Fupdate-password`,
      });
    } catch {
      // Silencioso a propósito: nada debe distinguir éxito de error.
    }
  }

  return { done: true };
}
