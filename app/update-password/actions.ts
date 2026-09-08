"use server";

import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthClaims } from "@/lib/auth/claims";

export interface UpdatePasswordState {
  error: string | null;
}

const MIN_LENGTH = 12;

/**
 * Cambia la contraseña del usuario.
 *
 * Requiere una sesión válida establecida por el enlace de recuperación (el
 * callback la crea antes de redirigir acá). Como /update-password queda FUERA
 * del matcher de `proxy.ts`, esta validación se hace explícitamente en la
 * action y también en la página.
 */
export async function updatePasswordAction(
  _prev: UpdatePasswordState,
  formData: FormData,
): Promise<UpdatePasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < MIN_LENGTH) {
    return { error: `La contraseña debe tener al menos ${MIN_LENGTH} caracteres.` };
  }
  if (password !== confirm) {
    return { error: "Las contraseñas no coinciden." };
  }

  const claims = await getAuthClaims();
  if (!claims) {
    return { error: "El enlace de recuperación no es válido o expiró. Pedí uno nuevo." };
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: "No se pudo actualizar la contraseña. Probá de nuevo." };
  }

  redirect("/login?updated=1");
}
