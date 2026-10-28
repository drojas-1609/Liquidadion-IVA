import { describe, it, expect } from "vitest";
import { DEV_REF, PROD_REF, classifyDatabaseUrl, classifySupabaseUrl, evaluateFixtureGate, type Env } from "@/lib/preview-fixtures/gate";

/** Credenciales SINTÉTICAS (nunca válidas): sirven para comprobar que no aparecen en los motivos. */
const PW = "ClaveSintetica-NoReal-987";
const NOW = new Date("2026-10-27T12:00:00Z");
const DEV_DIRECT = `postgresql://postgres:${PW}@db.${DEV_REF}.supabase.co:5432/postgres`;
const DEV_POOLER = `postgresql://postgres.${DEV_REF}:${PW}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;
const PROD_DIRECT = `postgresql://postgres:${PW}@db.${PROD_REF}.supabase.co:5432/postgres`;
const PROD_POOLER = `postgresql://postgres.${PROD_REF}:${PW}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;

const build: Env = {
    CONTEXT: "deploy-preview",
    CATALOGOS_SINTETICOS: "1",
    CATALOGOS_SINTETICOS_HASTA: "2026-10-29T12:00:00Z",
    DATABASE_URL: DEV_POOLER,
    DIRECT_URL: DEV_DIRECT,
    NEXT_PUBLIC_SUPABASE_URL: `https://${DEV_REF}.supabase.co`,
};
const runtime: Env = { ...build, CONTEXT: undefined, CATALOG_FIXTURES_BUILD: "1" };
const g = (env: Env, phase: "build" | "runtime" = "build") => evaluateFixtureGate(env, phase, NOW);

describe("clasificación de destinos (sin exponer valores)", () => {
    it("PostgreSQL: sólo DEV directa o pooler con usuario de DEV", () => {
        expect(classifyDatabaseUrl(DEV_DIRECT)).toBe("dev");
        expect(classifyDatabaseUrl(DEV_POOLER)).toBe("dev");
        expect(classifyDatabaseUrl(PROD_DIRECT)).toBe("prod");
        expect(classifyDatabaseUrl(PROD_POOLER)).toBe("prod");
        expect(classifyDatabaseUrl(`postgresql://postgres.otroref:${PW}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`)).toBe("other");
        expect(classifyDatabaseUrl(`postgresql://postgres:${PW}@db.example.com:5432/postgres`)).toBe("other");
        expect(classifyDatabaseUrl(`https://db.${DEV_REF}.supabase.co`)).toBe("invalid");
        expect(classifyDatabaseUrl("no es una url")).toBe("invalid");
        expect(classifyDatabaseUrl(undefined)).toBe("missing");
        expect(classifyDatabaseUrl(`postgresql://postgres:${PW}@db.${DEV_REF}.supabase.co:5432/postgres?options=${PROD_REF}`)).toBe("prod");
    });
    it("Supabase: exactamente https://<DEV>.supabase.co", () => {
        expect(classifySupabaseUrl(`https://${DEV_REF}.supabase.co`)).toBe("dev");
        expect(classifySupabaseUrl(`https://${DEV_REF}.supabase.co/`)).toBe("dev");
        expect(classifySupabaseUrl(`https://${PROD_REF}.supabase.co`)).toBe("prod");
        expect(classifySupabaseUrl(`http://${DEV_REF}.supabase.co`)).toBe("other");
        expect(classifySupabaseUrl(`https://${DEV_REF}.supabase.co:8443`)).toBe("other");
        expect(classifySupabaseUrl(`https://${DEV_REF}.supabase.co/otra`)).toBe("other");
        expect(classifySupabaseUrl(`https://${DEV_REF}.supabase.co.atacante.test`)).toBe("other");
        expect(classifySupabaseUrl("")).toBe("missing");
    });
});

describe("barrera de build", () => {
    it("Deploy Preview + activación + DEV completo: habilitada", () => {
        expect(g(build)).toEqual({ enabled: true, reasons: [] });
        expect(g({ ...build, DIRECT_URL: undefined }).enabled).toBe(true); // DIRECT_URL opcional
    });
    it.each([
        ["producción", { CONTEXT: "production" }],
        ["branch deploy", { CONTEXT: "branch-deploy" }],
        ["sin CONTEXT (build local)", { CONTEXT: undefined }],
        ["sin activación", { CATALOGOS_SINTETICOS: undefined }],
        ["activación «true»", { CATALOGOS_SINTETICOS: "true" }],
        ["activación «0»", { CATALOGOS_SINTETICOS: "0" }],
        ["sin vencimiento", { CATALOGOS_SINTETICOS_HASTA: undefined }],
        ["vencida", { CATALOGOS_SINTETICOS_HASTA: "2026-10-27T11:59:59Z" }],
        ["más de 7 días", { CATALOGOS_SINTETICOS_HASTA: "2026-11-04T12:00:01Z" }],
        ["fecha sin zona", { CATALOGOS_SINTETICOS_HASTA: "2026-10-29T12:00:00" }],
        ["fecha sólo día", { CATALOGOS_SINTETICOS_HASTA: "2026-10-29" }],
        ["DATABASE_URL de PROD", { DATABASE_URL: PROD_DIRECT }],
        ["DATABASE_URL pooler de PROD", { DATABASE_URL: PROD_POOLER }],
        ["DATABASE_URL faltante", { DATABASE_URL: undefined }],
        ["DATABASE_URL ajena", { DATABASE_URL: `postgresql://u:${PW}@localhost:5432/x` }],
        ["DIRECT_URL de PROD con DATABASE_URL de DEV (contradictorio)", { DIRECT_URL: PROD_DIRECT }],
        ["Supabase de PROD con base de DEV (contradictorio)", { NEXT_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co` }],
        ["Supabase faltante", { NEXT_PUBLIC_SUPABASE_URL: undefined }],
    ])("%s: deshabilitada", (_label, over) => {
        const r = g({ ...build, ...over } as Env);
        expect(r.enabled).toBe(false);
        expect(r.reasons.length).toBeGreaterThan(0);
    });
    it("los motivos nunca incluyen valores ni credenciales", () => {
        const r = g({ CONTEXT: "production", CATALOGOS_SINTETICOS: "si", DATABASE_URL: PROD_DIRECT, DIRECT_URL: PROD_POOLER, NEXT_PUBLIC_SUPABASE_URL: "https://x.test" });
        const text = r.reasons.join(" ");
        expect(text).not.toContain(PW);
        expect(text).not.toContain("x.test");
        expect(text).not.toContain("aws-0");
        expect(text).toMatch(/DATABASE_URL no es DEV \(prod\)/);
    });
});

describe("barrera de runtime (reevaluada en cada uso)", () => {
    it("build empaquetado + entorno DEV vigente: habilitada", () => {
        expect(evaluateFixtureGate(runtime, "runtime", NOW)).toEqual({ enabled: true, reasons: [] });
    });
    it("el build no los empaquetó (constante «0» o ausente): deshabilitada aunque el entorno sea correcto", () => {
        expect(evaluateFixtureGate({ ...runtime, CATALOG_FIXTURES_BUILD: "0" }, "runtime", NOW).enabled).toBe(false);
        expect(evaluateFixtureGate({ ...runtime, CATALOG_FIXTURES_BUILD: undefined }, "runtime", NOW).enabled).toBe(false);
    });
    it("vencimiento: se apaga sin redeploy cuando pasa CATALOGOS_SINTETICOS_HASTA", () => {
        expect(evaluateFixtureGate(runtime, "runtime", new Date("2026-10-29T11:59:59Z")).enabled).toBe(true);
        expect(evaluateFixtureGate(runtime, "runtime", new Date("2026-10-29T12:00:00Z")).enabled).toBe(false);
    });
    it("CONTEXT de producción visible en runtime, o destino cambiado a PROD: deshabilitada", () => {
        expect(evaluateFixtureGate({ ...runtime, CONTEXT: "production" }, "runtime", NOW).enabled).toBe(false);
        expect(evaluateFixtureGate({ ...runtime, DATABASE_URL: PROD_POOLER }, "runtime", NOW).enabled).toBe(false);
        expect(evaluateFixtureGate({ ...runtime, CATALOGOS_SINTETICOS: undefined }, "runtime", NOW).enabled).toBe(false);
    });
});
