import { NextResponse, type NextRequest } from "next/server";

import { resolveProxySession } from "@/lib/supabase/proxy-session";
import { isPublicPath } from "@/lib/auth/proxy-matcher";
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

// Debe ser un literal estático (Next lo parsea en compilación). Se mantiene en
// sync con `PROXY_MATCHER` de lib/auth/proxy-matcher.ts vía proxy-gate.test.ts.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|login|reset-password|update-password|logout|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff2?|ttf|txt)$).*)",
  ],
};

export default proxy;
