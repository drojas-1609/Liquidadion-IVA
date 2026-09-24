import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { getSupabasePublicEnv } from "./env";

export interface ProxySessionResult {
  /** Respuesta con las cookies de sesión refrescadas y headers anti-caché. */
  response: NextResponse;
  /** `true` solo si `getClaims()` verificó un JWT con `sub`. */
  isAuthenticated: boolean;
}

/**
 * Se ejecuta en `proxy.ts` (Next.js 16; `middleware` está deprecado).
 *
 * Refresca el token de Supabase y decide "hay sesión / no hay sesión" con
 * `getClaims()` (verificación local de la firma). Es un **gate grueso**: NO
 * autoriza por organización ni por rol; eso vive en cada handler/página (3B).
 */
export async function resolveProxySession(
  request: NextRequest,
): Promise<ProxySessionResult> {
  let response = NextResponse.next({ request });
  const { url, anonKey } = getSupabasePublicEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  let isAuthenticated = false;
  try {
    const { data, error } = await supabase.auth.getClaims();
    const sub = data?.claims?.sub;
    isAuthenticated = !error && typeof sub === "string" && sub.length > 0;
  } catch {
    isAuthenticated = false;
  }

  // Nunca cachear respuestas que pasaron por el gate de sesión.
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");

  return { response, isAuthenticated };
}
