import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { UnauthenticatedError } from "@/lib/auth/errors";

/**
 * Identidad verificada del usuario para el servidor.
 *
 * `sub` = `auth.users.id` (UUID) y es la ÚNICA clave de identidad/autorización.
 * `email` es una copia de conveniencia tomada del claim; no es identidad.
 */
export interface AuthClaims {
  sub: string;
  email: string | null;
  /** Rol de Supabase Auth (p. ej. "authenticated"); NO es el Role de la app. */
  authRole: string | null;
  raw: Record<string, unknown>;
}

function normalizeClaims(input: unknown): AuthClaims | null {
  if (!input || typeof input !== "object") return null;
  const c = input as Record<string, unknown>;
  const sub = typeof c.sub === "string" && c.sub.length > 0 ? c.sub : null;
  if (!sub) return null;
  return {
    sub,
    email: typeof c.email === "string" ? c.email : null,
    authRole: typeof c.role === "string" ? c.role : null,
    raw: c,
  };
}

/**
 * Devuelve los claims verificados o `null` si no hay sesión válida.
 *
 * Usa `supabase.auth.getClaims()`, que verifica la firma del JWT localmente
 * (WebCrypto + JWKS) cuando el proyecto usa claves asimétricas (dev: ES256).
 * NUNCA se usa `getSession()` para decidir acceso.
 */
export async function getAuthClaims(): Promise<AuthClaims | null> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error) return null;
  return normalizeClaims(data?.claims ?? null);
}

/** Igual que `getAuthClaims` pero lanza `UnauthenticatedError` si no hay sesión. */
export async function requireAuthClaims(): Promise<AuthClaims> {
  const claims = await getAuthClaims();
  if (!claims) throw new UnauthenticatedError();
  return claims;
}
