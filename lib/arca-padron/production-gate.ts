import "server-only";
import { X509Certificate } from "node:crypto";
import { normalizeCuit } from "../cuit";
import { PADRON_ENDPOINTS } from "./padron";
import { WSAA_ENDPOINTS } from "./wsaa";
export { ARCA_PROD_BUILD_FLAG, ARCA_PROD_BRANCH, arcaProdBuildEligible } from "./production-build";

/**
 * Compuerta de la consulta a ARCA en PRODUCCIÓN. Independiente de las
 * barreras de homologación (preview-gate.ts): ninguna variable de una abre la
 * otra, y la presencia de variables de homologación o del ensayo local cierra
 * ésta. Fail-closed: cualquier dato ausente o dudoso devuelve un motivo (nombre
 * de la condición, nunca valores) y la consulta no se realiza.
 *
 * Capas, todas obligatorias:
 *   1. Build: Netlify, contexto production, rama main (constante inlineada).
 *   2. Runtime: variables ARCA de producción, base y Supabase de PROD.
 *   3. Certificado: huella SHA-256 y CN declarados por el operador, CUIT del
 *      sujeto y vigencia (la pareja con la clave la exige cms.ts).
 *   4. Base: interruptor global y habilitación de la organización
 *      (production-switch.ts), leídos en cada consulta.
 */
/**
 * CN esperado del certificado de producción, declarado por el operador en
 * ARCA_WSAA_CERT_CN (sin valor por defecto). Formato conservador: 1–64
 * caracteres [A-Za-z0-9 ._-], sin espacios al inicio ni al final. Ausente o
 * con otro formato: la compuerta queda cerrada. La comparación es exacta.
 */
export function declaredCertificateCn(raw: string | undefined): string | null {
    return typeof raw === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/.test(raw) ? raw : null;
}
const PROD_REF = "bqqruaikbqculvmtirvy";
const EXPECTED_ENDPOINTS = {
    padron: "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5",
    wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
} as const;
const HOMO_OR_LOCAL_VARS = ["ARCA_HOMO_PREVIEW", "ARCA_HOMO_HASTA", "ARCA_LOCAL_HOMO", "ARCA_LOCAL_BIND"] as const;

type Env = Readonly<Record<string, string | undefined>>;
export type ProdGateResult = { ok: true } | { ok: false; reason: string };

function prodDatabase(raw: string | undefined): boolean {
    if (!raw) return false;
    try {
        const u = new URL(raw);
        if (!["postgres:", "postgresql:"].includes(u.protocol) || u.pathname !== "/postgres") return false;
        return (u.hostname === `db.${PROD_REF}.supabase.co` && decodeURIComponent(u.username) === "postgres")
            || (u.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(u.username) === `postgres.${PROD_REF}`);
    } catch {
        return false;
    }
}

function subjectFields(subject: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const line of subject.split("\n")) {
        const i = line.indexOf("=");
        if (i <= 0) continue;
        const k = line.slice(0, i), v = line.slice(i + 1);
        out.set(k, [...(out.get(k) ?? []), v]);
    }
    return out;
}

/**
 * Certificado de producción. Controles: huella declarada por el operador
 * (ARCA_WSAA_CERT_SHA256), CN declarado (ARCA_WSAA_CERT_CN, coincidencia
 * exacta con un único CN del sujeto), PEM X.509 legible y vigencia (la pareja
 * con la clave y RSA >= 2048 los exige cms.ts; la cadena la valida WSAA,
 * manual §10.2). Control por supuesto: serialNumber "CUIT <11 dígitos válidos>"
 * en el sujeto (motivo propio CERT_SUJETO_NO_CONFIRMADO). No se valida el
 * emisor: las fuentes consultadas no publican su nombre por ambiente.
 */
export function productionCertificateCheck(certPem: string | undefined, pin: string | undefined, expectedCn: string | undefined, nowMs: number): ProdGateResult {
    if (!certPem || !pin || !/^[a-f0-9]{64}$/.test(pin)) return { ok: false, reason: "ARCA_WSAA_CERT_SHA256" };
    const cnWanted = declaredCertificateCn(expectedCn);
    if (!cnWanted) return { ok: false, reason: "ARCA_WSAA_CERT_CN" };
    let cert: X509Certificate;
    try {
        cert = new X509Certificate(certPem);
    } catch {
        return { ok: false, reason: "ARCA_WSAA_CERT_PEM" };
    }
    if (cert.fingerprint256.replace(/:/g, "").toLowerCase() !== pin) return { ok: false, reason: "ARCA_WSAA_CERT_SHA256" };
    const from = Date.parse(cert.validFrom), to = Date.parse(cert.validTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || nowMs < from || nowMs >= to) return { ok: false, reason: "CERT_VIGENCIA" };
    const subject = subjectFields(cert.subject);
    const cn = subject.get("CN") ?? [], serial = subject.get("serialNumber") ?? [];
    if (cn.length !== 1 || cn[0] !== cnWanted) return { ok: false, reason: "CERT_CN" };
    const cuit = /^CUIT (\d{11})$/.exec(serial.length === 1 ? serial[0] : "");
    if (!cuit || !normalizeCuit(cuit[1]).ok) return { ok: false, reason: "CERT_SUJETO_NO_CONFIRMADO" };
    return { ok: true };
}

/**
 * `prodBuilt`, `homoBuilt` y `nodeEnv` son constantes que Next inlinea en el
 * build: el llamador pasa `process.env.ARCA_PROD_BUILD_ELIGIBLE`,
 * `process.env.ARCA_HOMO_BUILD_ELIGIBLE` y `process.env.NODE_ENV` LITERALES
 * (no leídos del objeto env en runtime, que Netlify podría no poblar).
 */
export function arcaProdRuntimeEligible(env: Env, prodBuilt: string | undefined, homoBuilt: string | undefined, nodeEnv: string | undefined, nowMs: number): ProdGateResult {
    if (prodBuilt !== "1") return { ok: false, reason: "BUILD" };
    if (homoBuilt === "1") return { ok: false, reason: "BUILD_HOMOLOGACION" };
    if (nodeEnv !== "production") return { ok: false, reason: "NODE_ENV" };
    if (env.ARCA_PADRON_ENABLED !== "true") return { ok: false, reason: "ARCA_PADRON_ENABLED" };
    if (env.ARCA_PADRON_ENV !== "produccion") return { ok: false, reason: "ARCA_PADRON_ENV" };
    const homo = HOMO_OR_LOCAL_VARS.find((k) => env[k] !== undefined);
    if (homo) return { ok: false, reason: homo };
    if (!prodDatabase(env.DATABASE_URL) || (env.DIRECT_URL !== undefined && !prodDatabase(env.DIRECT_URL))) return { ok: false, reason: "DATABASE_URL" };
    try {
        const u = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
        if (u.origin !== `https://${PROD_REF}.supabase.co` || u.pathname !== "/" || u.search || u.hash || u.username || u.password) return { ok: false, reason: "NEXT_PUBLIC_SUPABASE_URL" };
    } catch {
        return { ok: false, reason: "NEXT_PUBLIC_SUPABASE_URL" };
    }
    if (PADRON_ENDPOINTS.produccion !== EXPECTED_ENDPOINTS.padron || WSAA_ENDPOINTS.produccion !== EXPECTED_ENDPOINTS.wsaa) return { ok: false, reason: "DESTINOS" };
    return productionCertificateCheck(env.ARCA_WSAA_CERT_PEM, env.ARCA_WSAA_CERT_SHA256, env.ARCA_WSAA_CERT_CN, nowMs);
}
