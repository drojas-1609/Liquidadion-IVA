import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { createCipheriv, generateKeyPairSync, randomBytes, createHash } from "node:crypto";
import forge from "node-forge";
import { arcaProdBuildEligible, arcaProdRuntimeEligible, productionCertificateCheck, ARCA_PROD_CERT_CN } from "@/lib/arca-padron/production-gate";
import { openTicket, sealTicket, cacheKeyId } from "@/lib/arca-padron/ticket-store";
import { readQuotaConfig, arcaQuotaRules, ARCA_QUOTA_DEFAULTS } from "@/lib/arca-padron/quota-store";
import { productionLookup, auditResultOf, type ProductionLookupIo } from "@/lib/arca-padron/production-lookup";
import { defaultLookupDeps, type LookupDeps } from "@/lib/arca-padron/service";
import { sanitizeAuditMetadata } from "@/lib/auth/audit";

// Datos SINTÉTICOS: certificados autofirmados locales, CUIT ficticio y URLs con credenciales de ejemplo.
const CUIT = "20700000037";
const PROD = "bqqruaikbqculvmtirvy";
const NOW = Date.parse("2026-11-02T12:00:00Z");
let prodCert: string, prodKey: string, homoCert: string, pin: string;

function selfSigned(cn: string, keyPem: string, serial = `CUIT ${CUIT}`, days = 30): string {
    const key = forge.pki.privateKeyFromPem(keyPem);
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date(NOW - 86400000);
    cert.validity.notAfter = new Date(NOW + days * 86400000);
    const attrs = [{ shortName: "C", value: "AR" }, { shortName: "O", value: "ESTUDIO SINTETICO" }, { shortName: "CN", value: cn }, { name: "serialNumber", value: serial }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(key, forge.md.sha256.create());
    return forge.pki.certificateToPem(cert);
}
const fingerprint = (pem: string) => createHash("sha256").update(Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64")).digest("hex");

beforeAll(() => {
    prodKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    prodCert = selfSigned(ARCA_PROD_CERT_CN, prodKey);
    homoCert = selfSigned("TaxLiquidator homologacion", prodKey);
    pin = fingerprint(prodCert);
});
afterEach(() => vi.unstubAllEnvs());

const prodEnv = () => ({
    NODE_ENV: "production",
    ARCA_PADRON_ENABLED: "true",
    ARCA_PADRON_ENV: "produccion",
    ARCA_PADRON_CUIT_REPRESENTADA: CUIT,
    ARCA_WSAA_CERT_PEM: prodCert,
    ARCA_WSAA_CERT_SHA256: pin,
    ARCA_WSAA_KEY_PEM: prodKey,
    ARCA_WSAA_CACHE_KEY: Buffer.alloc(32, 3).toString("base64"),
    DATABASE_URL: `postgresql://postgres.${PROD}:sintetica@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`,
    DIRECT_URL: `postgresql://postgres:sintetica@db.${PROD}.supabase.co:5432/postgres`,
    NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co`,
} as Record<string, string | undefined>);

describe("compuerta de producción — build", () => {
    it("sólo Netlify, contexto production y rama main", () => {
        expect(arcaProdBuildEligible({ NETLIFY: "true", CONTEXT: "production", HEAD: "main" })).toBe(true);
        for (const env of [{}, { NETLIFY: "true", CONTEXT: "deploy-preview", HEAD: "main" }, { NETLIFY: "true", CONTEXT: "production", HEAD: "otra" }, { CONTEXT: "production", HEAD: "main" }])
            expect(arcaProdBuildEligible(env)).toBe(false);
    });
});

describe("compuerta de producción — runtime (deshabilitada por defecto)", () => {
    it("abre sólo con build, variables, base PROD y certificado de producción", () => {
        expect(arcaProdRuntimeEligible(prodEnv(), "1", "0", "production", NOW)).toEqual({ ok: true });
    });
    it.each([
        ["sin build", (e: Record<string, string | undefined>) => e, "0", "0", "BUILD"],
        ["build de homologación", (e: Record<string, string | undefined>) => e, "1", "1", "BUILD_HOMOLOGACION"],
        ["sin habilitar", (e: Record<string, string | undefined>) => ({ ...e, ARCA_PADRON_ENABLED: undefined }), "1", "0", "ARCA_PADRON_ENABLED"],
        ["ambiente homologación", (e: Record<string, string | undefined>) => ({ ...e, ARCA_PADRON_ENV: "homologacion" }), "1", "0", "ARCA_PADRON_ENV"],
        ["variable de Preview presente", (e: Record<string, string | undefined>) => ({ ...e, ARCA_HOMO_PREVIEW: "1" }), "1", "0", "ARCA_HOMO_PREVIEW"],
        ["variable del ensayo local presente", (e: Record<string, string | undefined>) => ({ ...e, ARCA_LOCAL_HOMO: "0" }), "1", "0", "ARCA_LOCAL_HOMO"],
        ["base DEV", (e: Record<string, string | undefined>) => ({ ...e, DATABASE_URL: "postgresql://postgres.esyfpakajthdifhnhcew:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres" }), "1", "0", "DATABASE_URL"],
        ["DIRECT_URL ajena", (e: Record<string, string | undefined>) => ({ ...e, DIRECT_URL: "postgresql://postgres:x@127.0.0.1:5432/postgres" }), "1", "0", "DATABASE_URL"],
        ["Supabase DEV", (e: Record<string, string | undefined>) => ({ ...e, NEXT_PUBLIC_SUPABASE_URL: "https://esyfpakajthdifhnhcew.supabase.co" }), "1", "0", "NEXT_PUBLIC_SUPABASE_URL"],
        ["sin huella", (e: Record<string, string | undefined>) => ({ ...e, ARCA_WSAA_CERT_SHA256: undefined }), "1", "0", "ARCA_WSAA_CERT_SHA256"],
        ["huella de otro certificado", (e: Record<string, string | undefined>) => ({ ...e, ARCA_WSAA_CERT_SHA256: "0".repeat(64) }), "1", "0", "ARCA_WSAA_CERT_SHA256"],
    ])("cerrada: %s", (_label, mutate, prodBuilt, homoBuilt, reason) => {
        const r = arcaProdRuntimeEligible(mutate(prodEnv()), prodBuilt, homoBuilt, "production", NOW);
        expect(r).toEqual({ ok: false, reason });
        expect(JSON.stringify(r)).not.toMatch(/sintetica|BEGIN/);
    });
    it("NODE_ENV se toma del valor inlineado por el build, no del objeto env de runtime", () => {
        for (const nodeEnv of ["development", "test", undefined])
            expect(arcaProdRuntimeEligible(prodEnv(), "1", "0", nodeEnv, NOW)).toEqual({ ok: false, reason: "NODE_ENV" });
        // Aunque el env de runtime no traiga NODE_ENV, el valor inlineado "production" basta para esta capa.
        expect(arcaProdRuntimeEligible({ ...prodEnv(), NODE_ENV: undefined }, "1", "0", "production", NOW)).toEqual({ ok: true });
    });
    it("rechaza el certificado de homologación aunque su huella esté declarada, con el motivo del supuesto no confirmado", () => {
        expect(productionCertificateCheck(homoCert, fingerprint(homoCert), NOW)).toEqual({ ok: false, reason: "CERT_SUJETO_NO_CONFIRMADO" });
    });
    it("rechaza un certificado sin CUIT válido o vencido", () => {
        const noCuit = selfSigned(ARCA_PROD_CERT_CN, prodKey, "CUIT 20700000030");
        expect(productionCertificateCheck(noCuit, fingerprint(noCuit), NOW)).toEqual({ ok: false, reason: "CERT_SUJETO_NO_CONFIRMADO" });
        expect(productionCertificateCheck(prodCert, pin, NOW + 60 * 86400000)).toEqual({ ok: false, reason: "CERT_VIGENCIA" });
        expect(productionCertificateCheck("no-pem", pin, NOW)).toEqual({ ok: false, reason: "ARCA_WSAA_CERT_PEM" });
    });
});

describe("defaultLookupDeps — barreras separadas", () => {
    it("sin variables: no configurada y sin producción", () => {
        const d = defaultLookupDeps({}, () => NOW);
        expect(d.config.configured).toBe(false);
        expect(d.production).toBeUndefined();
    });
    it("producción completa: destinos de producción, cupos y almacén compartido; sin perfil de homologación", () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("ARCA_PROD_BUILD_ELIGIBLE", "1");
        vi.stubEnv("ARCA_HOMO_BUILD_ELIGIBLE", "0");
        const d = defaultLookupDeps(prodEnv(), () => NOW);
        expect(d.config).toMatchObject({ configured: true, environment: "produccion" });
        expect(d.production).toEqual({ quotas: { ...ARCA_QUOTA_DEFAULTS }, certificateKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(d.homologationTransport).toBeUndefined();
        expect(d.allowedCuits).toBeUndefined();
        expect(d.ticketStore).toBeDefined();
    });
    it("cupo configurado inválido o build de producción ausente: cerrada", () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("ARCA_PROD_BUILD_ELIGIBLE", "1");
        expect(defaultLookupDeps({ ...prodEnv(), ARCA_QUOTA_CERTIFICATE_PER_HOUR: "0" }, () => NOW).config.configured).toBe(false);
        vi.stubEnv("ARCA_PROD_BUILD_ELIGIBLE", "0");
        const closed = defaultLookupDeps(prodEnv(), () => NOW);
        expect(closed.config.configured).toBe(false);
        expect(closed.production).toBeUndefined();
    });
    it("NODE_ENV de pruebas: cerrada aunque todo lo demás esté completo", () => {
        vi.stubEnv("ARCA_PROD_BUILD_ELIGIBLE", "1");
        expect(defaultLookupDeps(prodEnv(), () => NOW).config.configured).toBe(false);
    });
    it("las variables de producción no abren la barrera de homologación", () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("ARCA_HOMO_BUILD_ELIGIBLE", "1");
        vi.stubEnv("ARCA_PROD_BUILD_ELIGIBLE", "1");
        expect(defaultLookupDeps({ ...prodEnv(), ARCA_HOMO_PREVIEW: "1" }, () => NOW).config.configured).toBe(false);
    });
});

describe("cifrado de tickets — rotación y compatibilidad", () => {
    const scope = "a".repeat(64);
    const ticket = { token: "TOKEN-SINTETICO", sign: "FIRMA-SINTETICA", expiresAt: NOW + 3600000 };
    const current = Buffer.alloc(32, 1), previous = Buffer.alloc(32, 2);
    /** Formato v1 de la versión anterior (sin identificador de clave). */
    function sealV1(key: Buffer): string {
        const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from(scope));
        const c = Buffer.concat([cipher.update(JSON.stringify(ticket), "utf8"), cipher.final()]);
        return ["v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), c.toString("base64")].join(".");
    }
    it("v2 identifica la clave sin revelarla", () => {
        const sealed = sealTicket(ticket, current, scope);
        expect(sealed.split(".")[0]).toBe("v2");
        expect(sealed.split(".")[1]).toBe(cacheKeyId(current));
        expect(sealed).not.toContain(current.toString("base64"));
        expect(openTicket(sealed, { current: previous, previous: current }, scope)).toEqual(ticket);
        expect(() => openTicket(sealed, previous, scope)).toThrow();
    });
    it("tickets v1 existentes: se leen con la clave vigente o con la anterior", () => {
        expect(openTicket(sealV1(current), current, scope)).toEqual(ticket);
        expect(openTicket(sealV1(previous), { current, previous }, scope)).toEqual(ticket);
        expect(() => openTicket(sealV1(previous), current, scope)).toThrow();
    });
    it("identificador de clave cambiado o alcance distinto: ilegible", () => {
        const parts = sealTicket(ticket, current, scope).split(".");
        parts[1] = cacheKeyId(previous);
        expect(() => openTicket(parts.join("."), { current, previous }, scope)).toThrow();
        expect(() => openTicket(sealTicket(ticket, current, scope), current, "b".repeat(64))).toThrow();
    });
});

describe("cupos propios configurables", () => {
    it("por defecto 10/min usuario, 60/h organización, 300/h certificado", () => {
        expect(readQuotaConfig({})).toEqual({ profilePerMinute: 10, organizationPerHour: 60, certificatePerHour: 300 });
        expect(arcaQuotaRules({ profileId: "p1", organizationId: "o1", certificateKey: "c1" }, readQuotaConfig({})!)).toEqual([
            { key: "u:p1", limit: 10, windowMs: 60000 },
            { key: "o:o1", limit: 60, windowMs: 3600000 },
            { key: "c:c1", limit: 300, windowMs: 3600000 },
        ]);
    });
    it("valores configurados válidos; inválidos cierran (null)", () => {
        expect(readQuotaConfig({ ARCA_QUOTA_PROFILE_PER_MINUTE: "3", ARCA_QUOTA_CERTIFICATE_PER_HOUR: "1000" })).toEqual({ profilePerMinute: 3, organizationPerHour: 60, certificatePerHour: 1000 });
        for (const bad of ["0", "-1", "1.5", "abc", "", "1001", "0010"]) expect(readQuotaConfig({ ARCA_QUOTA_ORGANIZATION_PER_HOUR: bad })).toBeNull();
    });
});

describe("consulta de producción — orden y fallos (sin red)", () => {
    const base = (): LookupDeps => ({
        fetchImpl: vi.fn() as unknown as typeof fetch,
        config: { configured: true, environment: "produccion", cuitRepresentada: CUIT, signer: async () => "QUJD" },
        nowMs: () => NOW,
        timeoutMs: 50,
        ticketCache: { get: () => null, set: () => {} },
        production: { quotas: { profilePerMinute: 10, organizationPerHour: 60, certificatePerHour: 300 }, certificateKey: "c".repeat(64) },
    });
    const TX = { auditLog: { create: async () => ({}) } }, RESULT_DB = { auditLog: { create: async () => ({}) } };
    function io(over: Partial<ProductionLookupIo> = {}) {
        const steps: string[] = [];
        const value: ProductionLookupIo = {
            enabled: vi.fn(async () => { steps.push("enabled"); return true; }),
            // Como el almacén real: el hook corre dentro de la transacción y su error anula el consumo.
            quotas: { consume: vi.fn(async (_rules, hook) => { steps.push("quota"); await hook?.(TX as never); return { ok: true as const }; }) },
            audit: vi.fn(async (db, entry) => { steps.push(`audit:${db === TX ? "tx" : "resultado"}:${entry.result}`); }),
            resultDb: RESULT_DB,
            lookup: vi.fn(async () => { steps.push("lookup"); return { status: "NOT_FOUND" as const, cuit: "20-70000003-7" }; }),
            newLookupId: () => "consulta-interna-1",
            ...over,
        };
        return { value, steps };
    }
    const input = { profileId: "p1", organizationId: "o1", cuit: "20-70000003-7" };
    it("habilitación -> cupos + intento (misma transacción) -> ARCA -> resultado, vinculados por id interno", async () => {
        const { value, steps } = io();
        expect(await productionLookup(input, base(), value)).toEqual({ kind: "LOOKUP", result: { status: "NOT_FOUND", cuit: "20-70000003-7" } });
        expect(steps).toEqual(["enabled", "quota", "audit:tx:STARTED", "lookup", "audit:resultado:NOT_FOUND"]);
        expect(value.audit).toHaveBeenNthCalledWith(1, TX, { organizationId: "o1", profileId: "p1", lookupId: "consulta-interna-1", result: "STARTED" });
        expect(value.audit).toHaveBeenNthCalledWith(2, RESULT_DB, { organizationId: "o1", profileId: "p1", lookupId: "consulta-interna-1", result: "NOT_FOUND" });
        expect(JSON.stringify((value.audit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("70000003");
        expect(value.quotas.consume).toHaveBeenCalledWith([
            { key: "u:p1", limit: 10, windowMs: 60000 },
            { key: "o:o1", limit: 60, windowMs: 3600000 },
            { key: "c:" + "c".repeat(64), limit: 300, windowMs: 3600000 },
        ], expect.any(Function));
    });
    it("si falla el registro del intento: no consume (lo garantiza la transacción) ni consulta", async () => {
        const failing = io({ audit: async () => { throw new Error("caída"); } });
        failing.value.quotas = { consume: async (_r, hook) => { await hook!(TX as never); return { ok: true as const }; } };
        expect(await productionLookup(input, base(), failing.value)).toEqual({ kind: "QUOTA_UNAVAILABLE" });
        expect(failing.value.lookup).not.toHaveBeenCalled();
    });
    it("organización no habilitada o interruptor apagado: no consume ni consulta", async () => {
        const { value, steps } = io({ enabled: async () => false });
        expect(await productionLookup(input, base(), value)).toEqual({ kind: "NOT_ENABLED" });
        expect(steps).toEqual([]);
    });
    it("fallo al leer la habilitación: no consume ni consulta", async () => {
        const { value, steps } = io({ enabled: async () => { throw new Error("postgres://x caído"); } });
        expect(await productionLookup(input, base(), value)).toEqual({ kind: "CONTROL_UNAVAILABLE" });
        expect(steps).toEqual([]);
    });
    it("fallo del almacén de cupos: no consulta ARCA", async () => {
        const { value, steps } = io({ quotas: { consume: async () => { throw new Error("caído"); } } });
        expect(await productionLookup(input, base(), value)).toEqual({ kind: "QUOTA_UNAVAILABLE" });
        expect(steps).toEqual(["enabled"]);
    });
    it("cupo agotado: Retry-After en segundos enteros hacia arriba, sin consulta", async () => {
        const { value, steps } = io({ quotas: { consume: async () => ({ ok: false as const, retryAfterMs: 1500 }) } });
        expect(await productionLookup(input, base(), value)).toEqual({ kind: "RATE_LIMITED", retryAfterSeconds: 2 });
        expect(steps).toEqual(["enabled"]);
    });
    it("falla el registro final: queda el intento, no se entrega el dato y no se repite la consulta", async () => {
        const calls: string[] = [];
        const { value } = io({ audit: async (db, e) => { calls.push(e.result); if (db === RESULT_DB) throw new Error("caída"); } });
        expect(await productionLookup(input, base(), value)).toEqual({ kind: "AUDIT_UNAVAILABLE" });
        expect(calls).toEqual(["STARTED", "NOT_FOUND"]);
        expect(value.lookup).toHaveBeenCalledTimes(1);
    });
    it("sin compuerta de producción: no hace nada", async () => {
        const { value, steps } = io();
        expect(await productionLookup(input, { ...base(), production: undefined }, value)).toEqual({ kind: "NOT_ENABLED" });
        expect(steps).toEqual([]);
    });
    it("ningún camino escribe en consola (ni CUIT, ni errores con credenciales)", async () => {
        const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
        const secret = () => { throw new Error("postgresql://postgres:CLAVE-SINTETICA@db/x TOKEN-SINTETICO"); };
        await productionLookup(input, base(), io({ enabled: async () => secret() }).value);
        await productionLookup(input, base(), io({ quotas: { consume: async () => secret() } }).value);
        await productionLookup(input, base(), io({ audit: async () => secret() }).value);
        await productionLookup(input, base(), io({ audit: async (db) => { if (db === RESULT_DB) secret(); } }).value);
        await productionLookup(input, base(), io().value);
        for (const spy of spies) {
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        }
    });
    it("metadatos de auditoría: sólo códigos fijos; nunca CUIT, texto de ARCA ni secretos", () => {
        expect(auditResultOf({ status: "ERROR", code: "AUTH" })).toBe("ERROR_AUTH");
        expect(auditResultOf({ status: "RETRY_LATER", retryAfterSeconds: 3 })).toBe("RETRY_LATER");
        expect(sanitizeAuditMetadata("arca.cuit_lookup", { result: "FOUND", cuit: "20700000037", response: "<xml/>", token: "t" })).toEqual({ result: "FOUND" });
        expect(sanitizeAuditMetadata("arca.cuit_lookup", { result: "No existe persona con ese Id" })).toEqual({});
    });
});
