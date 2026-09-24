/**
 * Cabeceras de seguridad base (Tarea 3A) — FUENTE ÚNICA.
 *
 * Se consume desde:
 *  - `next.config.ts`  -> respuestas renderizadas por Next (`async headers()`);
 *  - `proxy.ts`        -> respuestas que el proxy construye directamente
 *                         (redirect 303 a /login, 401 JSON, 503, 500).
 *
 * CSP: SÓLO `frame-ancestors 'none'` (anti-clickjacking). La CSP completa
 * (`script-src`, etc.) llega en la Tarea 3B.
 *
 * HSTS con `max-age=31536000` para coincidir exactamente con el valor que
 * Netlify agrega en el edge y evitar cabeceras contradictorias.
 */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
];

/**
 * Aplica el set a un objeto `Headers`. Idempotente (usa `set`, no `append`):
 * no duplica ni pisa cookies ni otros encabezados.
 */
export function applySecurityHeaders(headers: Headers): void {
  for (const { key, value } of SECURITY_HEADERS) headers.set(key, value);
}
