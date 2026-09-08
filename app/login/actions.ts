"use server";

import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";
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

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: "Credenciales inválidas." };
  }

  redirect(next);
}
