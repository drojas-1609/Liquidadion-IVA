import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { getSupabasePublicEnv } from "./env";

/**
 * Cliente de Supabase para el servidor (Server Components, Route Handlers,
 * Server Actions). Lee/escribe la sesión desde las cookies de la request.
 *
 * La autoridad de identidad es `supabase.auth.getClaims()` (ver
 * `lib/auth/claims.ts`). NUNCA usar `getSession()` para decidir acceso.
 */
export async function getSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabasePublicEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` llamado desde un Server Component: no se pueden escribir
          // cookies ahí. El refresco de token lo hace `proxy.ts`.
        }
      },
    },
  });
}
