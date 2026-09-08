import { NextResponse, type NextRequest } from "next/server";

import { resolveProxySession } from "@/lib/supabase/proxy-session";
import { isPublicPath, PROXY_MATCHER } from "@/lib/auth/proxy-matcher";
import { sanitizeNext } from "@/lib/auth/origin";

/**
 * Gate GRUESO de sesión (Next.js 16 usa `proxy`, no `middleware`).
 *
 * Solo responde a la pregunta "¿hay sesión válida?". NO autoriza por
 * organización ni por rol: esa decisión vive en cada Route Handler / página
 * (Tarea 3B). `/update-password` queda fuera del matcher a propósito y valida
 * su propia sesión de recuperación.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  // Defensa en profundidad por si el matcher deja pasar una ruta pública.
  if (isPublicPath(pathname)) return NextResponse.next();

  const { response, isAuthenticated } = await resolveProxySession(request);
  if (isAuthenticated) return response;

  const loginUrl = new URL("/login", request.nextUrl.origin);
  const nextTarget = sanitizeNext(pathname + search);
  if (nextTarget !== "/") loginUrl.searchParams.set("next", nextTarget);

  // 303: un POST a ruta protegida sin sesión pasa a GET /login.
  const redirect = NextResponse.redirect(loginUrl, { status: 303 });
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  redirect.headers.set("Cache-Control", "no-store, max-age=0");
  return redirect;
}

export const config = {
  matcher: [PROXY_MATCHER],
};

export default proxy;
