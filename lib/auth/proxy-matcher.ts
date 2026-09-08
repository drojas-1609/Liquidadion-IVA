/**
 * Rutas que quedan FUERA del gate de sesión de `proxy.ts` (accesibles sin
 * login): el propio login, el flujo de recuperación, el callback de correo,
 * el logout y los assets estáticos.
 *
 * `PROXY_MATCHER` (para `config.matcher`, inline en proxy.ts) e `isPublicPath`
 * (chequeo en runtime) describen el mismo conjunto; `proxy-gate.test.ts`
 * verifica que no se desincronicen. La lista de rutas de auth se matchea por
 * SEGMENTO EXACTO (p. ej. `/logout`, `/logout/...`, pero no `/logout-x`).
 */
export const PUBLIC_PREFIXES = [
  "/login",
  "/reset-password",
  "/update-password",
  "/logout",
  "/auth/callback",
  "/auth/confirm-recovery",
] as const;

const ASSET_EXT_RE = /\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff2?|ttf|txt)$/i;

export function isPublicPath(pathname: string): boolean {
  if (pathname === "/favicon.ico" || pathname === "/robots.txt") return true;
  if (pathname.startsWith("/_next/")) return true;
  if (ASSET_EXT_RE.test(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** Igual, carácter por carácter, al literal de `config.matcher` en proxy.ts. */
export const PROXY_MATCHER =
  "/((?!_next/|favicon\\.ico$|robots\\.txt$|login(?:/|$)|reset-password(?:/|$)|update-password(?:/|$)|logout(?:/|$)|auth/callback(?:/|$)|auth/confirm-recovery(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff2?|ttf|txt)$).*)";
