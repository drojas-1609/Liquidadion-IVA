import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({
    claims: { value: null as unknown },
    db: { current: null as unknown },
    outcome: null as unknown,
    calls: [] as unknown[],
}));
vi.mock("@/lib/auth/claims", () => ({ getAuthClaims: async () => H.claims.value }));
vi.mock("@/lib/prisma", () => ({
    get default() {
        return H.db.current;
    },
}));
// Compuerta de producción abierta de forma SIMULADA: ninguna variable ni credencial real.
vi.mock("@/lib/arca-padron/service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/arca-padron/service")>();
    return {
        ...actual,
        defaultLookupDeps: () => ({
            fetchImpl: () => Promise.reject(new Error("red no permitida")),
            config: { configured: true, environment: "produccion", cuitRepresentada: "20700000037", signer: async () => "QUJD" },
            nowMs: Date.now,
            timeoutMs: 50,
            ticketCache: { get: () => null, set: () => {} },
            production: { quotas: { profilePerMinute: 10, organizationPerHour: 60, certificatePerHour: 300 }, certificateKey: "c".repeat(64) },
        }),
    };
});
vi.mock("@/lib/arca-padron/production-lookup", () => ({
    productionLookup: async (input: unknown) => {
        H.calls.push(input);
        return H.outcome;
    },
}));

import { freshDbMock, freshRecorder, wireDb, makeWorld, claimsFor, SUB_OWNER_A, SUB_ADMIN_A, SUB_ACCOUNTANT_A, SUB_VIEWER_A, SUB_OWNER_B, ORG_A, ORG_B } from "./_harness";
import { POST } from "@/app/api/arca/cuit-lookup/route";
import { GET } from "@/app/api/arca/lookup-audit/route";

const CUIT = "30-44444444-0";
let db: ReturnType<typeof freshDbMock>;
let findMany: ReturnType<typeof vi.fn>;
beforeEach(() => {
    db = freshDbMock();
    wireDb(db, makeWorld({ clients: [], periods: [] }), freshRecorder());
    // 1.ª lectura: intentos; 2.ª: resultados de esos intentos (uno sin resultado final).
    findMany = vi.fn(async (args: { where: { targetId?: unknown } }) =>
        args.where.targetId
            ? [{ targetId: "id-1", metadata: { result: "FOUND" } }]
            : [
                  { createdAt: new Date("2026-11-02T12:05:00Z"), actorProfileId: SUB_OWNER_A, targetId: "id-2" },
                  { createdAt: new Date("2026-11-02T12:00:00Z"), actorProfileId: SUB_OWNER_A, targetId: "id-1" },
              ],
    );
    (db.auditLog as unknown as { findMany: unknown }).findMany = findMany;
    H.db.current = db;
    H.claims.value = claimsFor(SUB_OWNER_A);
    H.outcome = { kind: "LOOKUP", result: { status: "NOT_FOUND", cuit: CUIT } };
    H.calls = [];
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("red no permitida en tests"))));
});
afterEach(() => vi.unstubAllGlobals());

const lookup = (body: unknown) =>
    POST(new Request("http://localhost/api/arca/cuit-lookup", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("POST /api/arca/cuit-lookup — producción", () => {
    it("autenticación, rol y CUIT se validan ANTES de habilitación y cupos", async () => {
        H.claims.value = claimsFor(null);
        expect((await lookup({ cuit: CUIT })).status).toBe(401);
        H.claims.value = claimsFor(SUB_VIEWER_A);
        expect((await lookup({ cuit: CUIT })).status).toBe(403);
        H.claims.value = claimsFor(SUB_OWNER_A);
        expect((await lookup({ cuit: "30-44444444-1" })).status).toBe(422);
        expect(H.calls).toEqual([]);
    });
    it("usa la organización y el perfil de la sesión, nunca datos del cuerpo", async () => {
        await lookup({ cuit: CUIT, organizationId: ORG_B, profileId: SUB_OWNER_B });
        expect(H.calls).toEqual([{ profileId: SUB_OWNER_A, organizationId: ORG_A, cuit: CUIT }]);
    });
    it("organización no habilitada: 200 NOT_CONFIGURED (alta manual)", async () => {
        H.outcome = { kind: "NOT_ENABLED" };
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "NOT_CONFIGURED", message: "Consulta ARCA no configurada" });
    });
    it("cupo propio agotado: 429 con Retry-After y aviso de espera que no lo presenta como límite de ARCA", async () => {
        H.outcome = { kind: "RATE_LIMITED", retryAfterSeconds: 754 };
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("754");
        const body = await res.json();
        expect(body.error.code).toBe("RATE_LIMITED");
        expect(body.error.message).toBe("Se alcanzó el cupo interno de consultas a ARCA del estudio. Intentá de nuevo en 13 minutos.");
    });
    it.each(["CONTROL_UNAVAILABLE", "QUOTA_UNAVAILABLE", "AUDIT_UNAVAILABLE"])("%s: 503 sin datos", async (kind) => {
        H.outcome = { kind };
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBeNull();
        expect(await res.json()).toEqual({ error: { code: "ARCA_CONTROL_UNAVAILABLE", message: "La consulta a ARCA no está disponible en este momento. Completá los datos manualmente." } });
    });
    it("autenticación en espera: 503 con Retry-After", async () => {
        H.outcome = { kind: "LOOKUP", result: { status: "RETRY_LATER", retryAfterSeconds: 45 } };
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBe("45");
        expect((await res.json()).error.message).toContain("45 segundos");
    });
    it("almacén de tickets caído: 503", async () => {
        H.outcome = { kind: "LOOKUP", result: { status: "ERROR", code: "STORE_UNAVAILABLE" } };
        expect((await lookup({ cuit: CUIT })).status).toBe(503);
    });
});

describe("GET /api/arca/lookup-audit", () => {
    const get = () => GET(new Request("http://localhost/api/arca/lookup-audit"));
    it.each([[SUB_OWNER_A], [SUB_ADMIN_A]])("OWNER/ADMIN: sólo su organización, sin CUIT", async (sub) => {
        H.claims.value = claimsFor(sub);
        const res = await get();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            entries: [
                { at: "2026-11-02T12:05:00.000Z", actorProfileId: SUB_OWNER_A, result: "SIN_RESULTADO" },
                { at: "2026-11-02T12:00:00.000Z", actorProfileId: SUB_OWNER_A, result: "FOUND" },
            ],
        });
        for (const [args] of findMany.mock.calls) expect(args.where).toMatchObject({ organizationId: ORG_A, action: "arca.cuit_lookup", targetType: "ArcaPadronLookup" });
    });
    it.each([[SUB_ACCOUNTANT_A], [SUB_VIEWER_A]])("otros roles: 403 sin leer", async (sub) => {
        H.claims.value = claimsFor(sub);
        expect((await get()).status).toBe(403);
        expect(findMany).not.toHaveBeenCalled();
    });
    it("sin sesión: 401", async () => {
        H.claims.value = claimsFor(null);
        expect((await get()).status).toBe(401);
    });
    it("otra organización: sólo la propia", async () => {
        H.claims.value = claimsFor(SUB_OWNER_B);
        await get();
        for (const [args] of findMany.mock.calls) expect(args.where).toMatchObject({ organizationId: ORG_B });
    });
});
