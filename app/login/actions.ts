"use server";

import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigError } from "@/lib/supabase/env";
import { sanitizeNext } from "@/lib/auth/origin";

export interface LoginState {
  error: string | null;
}

/**
 * Inicio de sesión con correo + contraseña. NO hay registro público: solo
 * `signInWithPassword`. El mensaje de error es genérico (no revela si el
 * correo existe). El destino post-login se limita a un path interno.
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = sanitizeNext(
    typeof formData.get("next") === "string" ? (formData.get("next") as string) : null,
  );

  if (!email || !password) {
    return { error: "Ingresá tu correo y contraseña." };
  }

  let signInError: unknown = null;
  try {
    const supabase = await getSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    signInError = error;
  } catch (err) {
    if (isSupabaseConfigError(err)) {
      return { error: "El servicio de autenticación no está disponible en este momento." };
    }
    return { error: "No se pudo iniciar sesión. Probá de nuevo en unos minutos." };
  }

  if (signInError) {
    return { error: "Credenciales inválidas." };
  }

  redirect(next);
}
