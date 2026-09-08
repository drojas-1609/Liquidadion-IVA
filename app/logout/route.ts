import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getLogoutRedirectUrl } from "@/lib/auth/origin";
import { applySecurityHeaders } from "@/lib/security-headers";

const NO_STORE = "no-store, max-age=0";

/**
 * Cierre de sesión. Solo POST (evita logout por navegación/prefetch o CSRF via
 * <img>). Redirige al `/login` del MISMO host desde el que se originó la
 * request — validado contra una allow-list estricta en `getLogoutRedirectUrl`
 * (nunca un Host crudo, nunca una redirección abierta).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const supabase = await getSupabaseServerClient();
    await supabase.auth.signOut();
  } catch {
    // Sin sesión / sin config: igual mandamos a /login.
  }
  const res = NextResponse.redirect(getLogoutRedirectUrl(request), { status: 303 });
  res.headers.set("Cache-Control", NO_STORE);
  applySecurityHeaders(res.headers);
  return res;
}

export function GET(): NextResponse {
  const res = NextResponse.json(
    { error: "Usá POST para cerrar sesión." },
    { status: 405, headers: { Allow: "POST" } },
  );
  res.headers.set("Cache-Control", NO_STORE);
  applySecurityHeaders(res.headers);
  return res;
}
