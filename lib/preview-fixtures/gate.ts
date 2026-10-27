/**
 * Barreras de los catálogos y reglas SINTÉTICOS de prueba visual.
 *
 * Los fixtures sólo pueden servirse en un Deploy Preview de Netlify, con
 * activación explícita y conectado a Supabase DEV. Hay dos evaluaciones con la
 * MISMA función y por separado; las dos tienen que dar «habilitado»:
 *
 *  - build (`next.config.ts`): decide si los fixtures se EMPAQUETAN. Si no, el
 *    código que los importa se elimina del bundle (ver registry.ts).
 *  - runtime (cada llamada del registro, en el servidor): decide si se SIRVEN.
 *    Una activación vencida, o un cambio del destino, los apaga aunque siga
 *    publicado el mismo build.
 *
 * Todo depende sólo de variables de entorno del servidor: nada de parámetros
 * del navegador, cookies ni controles del cliente. Ante cualquier dato
 * faltante, inválido o contradictorio: deshabilitado. Los motivos nunca
 * incluyen valores (sólo nombres de variables y causas genéricas).
 *
 * Puro (sin `server-only`): lo importa también next.config.ts.
 */

export const DEV_REF = "esyfpakajthdifhnhcew";
export const PROD_REF = "bqqruaikbqculvmtirvy";

/** Variable de activación: exactamente "1". */
export const ACTIVATION_VAR = "CATALOGOS_SINTETICOS";
/** Fin de la activación (ISO 8601 con zona). Pasado ese instante, se apaga sin redeploy. */
export const UNTIL_VAR = "CATALOGOS_SINTETICOS_HASTA";
/** Constante inlineada por next.config.ts: "1" sólo si el build los empaquetó. */
export const BUILD_FLAG_VAR = "CATALOG_FIXTURES_BUILD";
/** Duración máxima de una activación. */
export const MAX_ACTIVATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Variables que se inspeccionan (nunca se devuelven sus valores). */
const CONNECTION_VARS = ["DATABASE_URL", "DIRECT_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const;

export type Env = Readonly<Record<string, string | undefined>>;

export interface GateResult {
    enabled: boolean;
    /** Causas de la desactivación, sin valores. Vacío si está habilitado. */
    reasons: string[];
}

/** Clasifica una URL de PostgreSQL de Supabase sin exponerla: sólo DEV directa o pooler de sesión con usuario de DEV. */
export function classifyDatabaseUrl(raw: string | undefined): "dev" | "prod" | "other" | "missing" | "invalid" {
    if (raw === undefined || raw.trim() === "") return "missing";
    if (raw.includes(PROD_REF)) return "prod";
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return "invalid";
    }
    if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") return "invalid";
    const host = u.hostname;
    const user = decodeURIComponent(u.username);
    if (host === `db.${DEV_REF}.supabase.co`) return "dev";
    if (host.endsWith(".pooler.supabase.com") && user === `postgres.${DEV_REF}`) return "dev";
    return "other";
}

/** NEXT_PUBLIC_SUPABASE_URL de DEV: exactamente https://<ref>.supabase.co (con o sin «/» final). */
export function classifySupabaseUrl(raw: string | undefined): "dev" | "prod" | "other" | "missing" | "invalid" {
    if (raw === undefined || raw.trim() === "") return "missing";
    if (raw.includes(PROD_REF)) return "prod";
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return "invalid";
    }
    if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return "other";
    if (u.hostname === `${DEV_REF}.supabase.co` && (u.pathname === "/" || u.pathname === "")) return "dev";
    return "other";
}

/**
 * Evalúa las barreras. `phase = "build"` exige además el contexto de Netlify
 * «deploy-preview»; `phase = "runtime"` exige además que el build los haya
 * empaquetado (`CATALOG_FIXTURES_BUILD = "1"`) y rechaza cualquier CONTEXT
 * distinto de deploy-preview si está definido.
 */
export function evaluateFixtureGate(env: Env, phase: "build" | "runtime", now: Date): GateResult {
    const reasons: string[] = [];
    const activation = env[ACTIVATION_VAR];
    if (activation === undefined || activation === "") reasons.push(`${ACTIVATION_VAR} no definida`);
    else if (activation !== "1") reasons.push(`${ACTIVATION_VAR} con un valor distinto de "1"`);

    const context = env.CONTEXT;
    if (phase === "build") {
        if (context !== "deploy-preview") reasons.push("el build no es un Deploy Preview (CONTEXT)");
    } else {
        if (context !== undefined && context !== "deploy-preview") reasons.push("CONTEXT definido y distinto de deploy-preview");
        if (env[BUILD_FLAG_VAR] !== "1") reasons.push("el build no empaquetó los fixtures");
    }

    const until = env[UNTIL_VAR];
    if (until === undefined || until.trim() === "") reasons.push(`${UNTIL_VAR} no definida`);
    else {
        // Sólo ISO 8601 completo con zona explícita (Z u offset).
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(until.trim())) {
            reasons.push(`${UNTIL_VAR} no es una fecha ISO con zona`);
        } else {
            const t = Date.parse(until.trim());
            if (Number.isNaN(t)) reasons.push(`${UNTIL_VAR} inválida`);
            else if (t <= now.getTime()) reasons.push(`${UNTIL_VAR} vencida`);
            else if (t - now.getTime() > MAX_ACTIVATION_MS) reasons.push(`${UNTIL_VAR} supera el máximo de 7 días`);
        }
    }

    const db = classifyDatabaseUrl(env.DATABASE_URL);
    if (db !== "dev") reasons.push(`DATABASE_URL no es DEV (${db})`);
    // DIRECT_URL es opcional para el runtime, pero si está definida debe ser DEV.
    if (env.DIRECT_URL !== undefined && env.DIRECT_URL !== "") {
        const direct = classifyDatabaseUrl(env.DIRECT_URL);
        if (direct !== "dev") reasons.push(`DIRECT_URL no es DEV (${direct})`);
    }
    const sb = classifySupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL);
    if (sb !== "dev") reasons.push(`NEXT_PUBLIC_SUPABASE_URL no es DEV (${sb})`);

    // Cualquier rastro de PROD en las variables de conexión: contradictorio.
    for (const k of CONNECTION_VARS) {
        if ((env[k] ?? "").includes(PROD_REF)) reasons.push(`${k} menciona el proyecto de PROD`);
    }
    return { enabled: reasons.length === 0, reasons: [...new Set(reasons)] };
}
