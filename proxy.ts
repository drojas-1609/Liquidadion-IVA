import { NextResponse, type NextRequest } from "next/server";

import { resolveProxySession } from "@/lib/supabase/proxy-session";
import { isSupabaseConfigError } from "@/lib/supabase/env";
import { isPublicPath } from "@/lib/auth/proxy-matcher";
import { sanitizeNext } from "@/lib/auth/origin";

/**
 * Gate GRUESO de sesión (Next.js 16 usa `proxy`, no `middleware`).
 *
 * Fail-closed en TODOS los entornos:
 *  - config de Supabase ausente/inválida -> 503 (API: JSON; página: texto).
 *  - error inesperado resolviendo la sesión -> 500 controlado.
 *  - sesión ausente/inválida -> API: 401 JSON; página: 303 a /login.
 *  - solo con sesión verificada por `getClaims()` se deja pasar.
 *
 * NO autoriza por organización ni por rol (eso vive en cada handler/página, 3B).
 * `/update-password` queda fuera del matcher y valida su propia sesión de
 * recuperación.
 */
const NO_STORE = "no-store, max-age=0";

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function jsonDeny(status: number, code: string, message: string): NextResponse {
  const res = NextResponse.json({ error: { code, message } }, { status });
  res.headers.set("Cache-Control", NO_STORE);
  return res;
}

function pageDeny(status: number, message: string): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { "Cache-Control": NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  // Defensa en profundidad por si el matcher deja pasar una ruta pública.
  if (isPublicPath(pathname)) return NextResponse.next();

  let session: Awaited<ReturnType<typeof resolveProxySession>>;
  try {
    session = await resolveProxySession(request);
  } catch (err) {
    if (isSupabaseConfigError(err)) {
      return isApiPath(pathname)
        ? jsonDeny(503, "MISCONFIGURED", "Servicio de autenticación no disponible.")
        : pageDeny(503, "Servicio no disponible temporalmente.");
    }
    // Cualquier otra excepción: negar, nunca continuar hacia contenido fiscal.
    return isApiPath(pathname)
      ? jsonDeny(500, "INTERNAL", "Error interno.")
      : pageDeny(500, "Error interno.");
  }

  const { response, isAuthenticated } = session;
  if (isAuthenticated) return response;

  // Sesión ausente/inválida.
  if (isApiPath(pathname)) {
    return jsonDeny(401, "UNAUTHENTICATED", "No autenticado.");
  }

  const loginUrl = new URL("/login", request.nextUrl.origin);
  const nextTarget = sanitizeNext(pathname + search);
  if (nextTarget !== "/") loginUrl.searchParams.set("next", nextTarget);

  // 303: un POST a ruta protegida sin sesión pasa a GET /login.
  const redirect = NextResponse.redirect(loginUrl, { status: 303 });
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  redirect.headers.set("Cache-Control", NO_STORE);
  return redirect;
}

export const config = {
  // Debe ser un literal estático (Next lo parsea en compilación). Se mantiene en
  // sync con `PROXY_MATCHER` de lib/auth/proxy-matcher.ts vía proxy-gate.test.ts.
  matcher: [
    "/((?!_next/|favicon\\.ico$|robots\\.txt$|login(?:/|$)|reset-password(?:/|$)|update-password(?:/|$)|logout(?:/|$)|auth/callback(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff2?|ttf|txt)$).*)",
  ],
};

export default proxy;
