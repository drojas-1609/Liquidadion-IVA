import "server-only";

/**
 * Origen confiable para construir URLs absolutas de redirección (login,
 * callback de correo, post-logout).
 *
 * Regla base: NUNCA confiar en `Host` / `X-Forwarded-Host` de la request sin
 * validarlos contra una allow-list estricta, y NUNCA aceptar una URL absoluta
 * provista por el cliente. El destino relativo (`next`) se sanea aparte con
 * `sanitizeNext` y debe ser siempre un path interno.
 *
 * Prioridad de resolución del origen:
 *   1. Deploy Preview de Netlify  -> DEPLOY_PRIME_URL, validado HTTPS + host
 *      que matchea exactamente `<algo>--liquidadoriva.netlify.app`.
 *   2. Producción                 -> AUTH_PRODUCTION_ORIGIN (si está) o URL de
 *      Netlify, validados como HTTPS de host único.
 *   3. Desarrollo local           -> http://localhost:3000 (solo si NODE_ENV
 *      !== "production").
 *   4. Fallback a la request       -> solo si su host pasa la allow-list.
 *   5. Último recurso              -> origen de producción conocido.
 */

const SITE = "liquidadoriva.netlify.app";

/** `deploy-preview-123--liquidadoriva.netlify.app`, `mi-branch--liquidadoriva.netlify.app`, ... */
const PREVIEW_HOST_RE = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?--${SITE.replace(/\./g, "\\.")}$`,
  "i",
);

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
/** `true` si `s` contiene algún carácter de control ASCII (0x00-0x1F) o DEL (0x7F). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

interface HeaderBag {
  get(name: string): string | null;
}
interface RequestLike {
  headers: HeaderBag;
}

function parseOrigin(value: string | undefined | null): URL | null {
  if (!value || typeof value !== "string") return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.host.includes(",")) return null;
  return u;
}

function fallbackProdOrigin(): string {
  const explicit = parseOrigin(process.env.AUTH_PRODUCTION_ORIGIN);
  if (explicit && explicit.protocol === "https:") return explicit.origin;
  return `https://${SITE}`;
}

function productionHost(): string | null {
  const e =
    parseOrigin(process.env.AUTH_PRODUCTION_ORIGIN) ?? parseOrigin(process.env.URL);
  return e ? e.host.toLowerCase() : SITE;
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(host);
}

function isAllowedFallbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (PREVIEW_HOST_RE.test(h)) return true;
  if (h === SITE) return true;
  const prod = productionHost();
  return prod != null && h === prod;
}

function firstToken(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

function originFromRequest(req: RequestLike | undefined): URL | null {
  if (!req) return null;
  const h = req.headers;
  const host = firstToken(h.get("x-forwarded-host")) ?? firstToken(h.get("host"));
  if (!host || !HOST_RE.test(host)) return null;
  // Sin `x-forwarded-proto` explícito: localhost es http, el resto https.
  const proto = (
    firstToken(h.get("x-forwarded-proto")) ?? (isLocalHost(host) ? "http" : "https")
  ).toLowerCase();
  if (proto !== "https" && proto !== "http") return null;
  return parseOrigin(`${proto}://${host}`);
}

/**
 * Resuelve el origen (`scheme://host[:port]`) al que es seguro redirigir.
 */
export function getTrustedOrigin(req?: RequestLike): string {
  const env = process.env;
  const context = env.CONTEXT; // Netlify: production | deploy-preview | branch-deploy | dev
  const isProd = env.NODE_ENV === "production";

  // 1. Deploy Preview
  if (context === "deploy-preview") {
    const o = parseOrigin(env.DEPLOY_PRIME_URL) ?? parseOrigin(env.DEPLOY_URL);
    if (o && o.protocol === "https:" && PREVIEW_HOST_RE.test(o.host)) return o.origin;
    return fallbackProdOrigin();
  }

  // 2. Producción
  if (context === "production" || (isProd && !context)) {
    const explicit = parseOrigin(env.AUTH_PRODUCTION_ORIGIN);
    if (explicit && explicit.protocol === "https:") return explicit.origin;
    const netlifyUrl = parseOrigin(env.URL);
    if (netlifyUrl && netlifyUrl.protocol === "https:") return netlifyUrl.origin;
    return fallbackProdOrigin();
  }

  // 2b. Branch deploy u otros contextos de Netlify: mismo patrón de host del sitio.
  if (context === "branch-deploy") {
    const o = parseOrigin(env.DEPLOY_PRIME_URL) ?? parseOrigin(env.URL);
    if (o && o.protocol === "https:" && PREVIEW_HOST_RE.test(o.host)) return o.origin;
    return fallbackProdOrigin();
  }

  // 3. Desarrollo local
  if (!isProd) {
    const fromReq = originFromRequest(req);
    if (fromReq && isLocalHost(fromReq.host)) return fromReq.origin;
    return "http://localhost:3000";
  }

  // 4. Fallback estricto a la request
  const fromReq = originFromRequest(req);
  if (fromReq && isAllowedFallbackHost(fromReq.host)) return fromReq.origin;

  // 5. Último recurso
  return fallbackProdOrigin();
}

/**
 * Sanea el parámetro `next`: debe ser un path interno.
 *  - empieza con "/" y NO con "//"  (nada de protocol-relative)
 *  - sin "\" (evita `/\evil.com`)
 *  - sin esquema embebido, espacios ni caracteres de control
 *  - se rechaza también si al decodificar aparece "//" o "\"
 * Cualquier otra cosa -> `fallback` ("/").
 */
export function sanitizeNext(raw: string | null | undefined, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  if (/\s/.test(raw)) return fallback;
  if (hasControlChar(raw)) return fallback;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(raw)) return fallback;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (decoded.startsWith("//") || decoded.includes("\\")) return fallback;

  return raw;
}

/** Construye una URL absoluta segura: origen confiable + `next` saneado. */
export function buildSafeRedirect(
  nextParam: string | null | undefined,
  req?: RequestLike,
  fallbackPath = "/",
): string {
  return `${getTrustedOrigin(req)}${sanitizeNext(nextParam, fallbackPath)}`;
}
