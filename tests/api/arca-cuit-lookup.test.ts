import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({
    claims: { throw: null as unknown, value: null as unknown },
    db: { current: null as unknown },
    lookup: null as null | ((cuit: unknown) => Promise<unknown>),
    limiter: { current: null as unknown },
}));
vi.mock("@/lib/auth/claims", () => ({
    getAuthClaims: async () => {
        if (H.claims.throw) throw H.claims.throw;
        return H.claims.value;
    },
}));
vi.mock("@/lib/prisma", () => ({
    get default() {
        return H.db.current;
    },
}));
// Sin H.lookup se usa la implementación REAL (sin variables ARCA -> no configurada).
vi.mock("@/lib/arca-padron/service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/arca-padron/service")>();
    return { ...actual, lookupCuit: (cuit: unknown) => (H.lookup ? H.lookup(cuit) : actual.lookupCuit(cuit)) };
});
vi.mock("@/lib/arca-padron/rate-limit", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/arca-padron/rate-limit")>();
    return {
        ...actual,
        get arcaLookupLimiter() {
            return H.limiter.current;
        },
    };
});

import { freshDbMock, freshRecorder, wireDb, makeWorld, claimsFor, clientRow, SUB_OWNER_A, SUB_ACCOUNTANT_A, SUB_VIEWER_A, ORG_A } from "./_harness";
import { SlidingWindowLimiter } from "@/lib/arca-padron/rate-limit";
import { POST } from "@/app/api/arca/cuit-lookup/route";

// Datos SINTÉTICOS.
const CUIT = "30-44444444-0";
const PERSON = {
    idPersona: "30444444440",
    name: "EMPRESA SINTETICA SA",
    personType: "JURIDICA",
    keyStatus: "ACTIVO",
    fiscalAddress: null,
    taxes: [],
    monotributoCategory: null,
    activities: [],
    notices: [],
    sourceDateTime: null,
};

let db: ReturnType<typeof freshDbMock>;
let world: ReturnType<typeof makeWorld>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
    db = freshDbMock();
    world = makeWorld({ clients: [clientRow("c1", ORG_A)], periods: [] });
    wireDb(db, world, freshRecorder());
    H.db.current = db;
    H.claims.throw = null;
    H.claims.value = claimsFor(SUB_OWNER_A);
    H.lookup = null;
    H.limiter.current = new SlidingWindowLimiter();
    fetchSpy = vi.fn(() => Promise.reject(new Error("red no permitida en tests")));
    vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

const lookup = (body: unknown) =>
    POST(
        new Request("http://localhost/api/arca/cuit-lookup", {
            method: "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json" },
        }),
    );

describe("POST /api/arca/cuit-lookup — autorización", () => {
    it("401 sin sesión, sin consultar", async () => {
        H.claims.value = claimsFor(null);
        const spy = vi.fn();
        H.lookup = spy;
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(401);
        expect(spy).not.toHaveBeenCalled();
    });
    it("403 para VIEWER (sólo quien puede crear clientes)", async () => {
        H.claims.value = claimsFor(SUB_VIEWER_A);
        const spy = vi.fn();
        H.lookup = spy;
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(403);
        expect(spy).not.toHaveBeenCalled();
    });
    it("ACCOUNTANT puede consultar", async () => {
        H.claims.value = claimsFor(SUB_ACCOUNTANT_A);
        expect((await lookup({ cuit: CUIT })).status).toBe(200);
    });
});

describe("POST /api/arca/cuit-lookup — entrada", () => {
    it.each([[{ cuit: "30-44444444-1" }], [{ cuit: "123" }], [{}], [{ cuit: 30444444440 }]])("422 CUIT inválido: %j", async (body) => {
        const spy = vi.fn();
        H.lookup = spy;
        const res = await lookup(body);
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ field: "cuit" });
        expect(spy).not.toHaveBeenCalled();
    });
    it("normaliza el CUIT antes de consultar", async () => {
        const spy = vi.fn(async () => ({ status: "NOT_FOUND", cuit: CUIT }));
        H.lookup = spy;
        await lookup({ cuit: " 30444444440 " });
        expect(spy).toHaveBeenCalledWith(CUIT);
    });
});

describe("POST /api/arca/cuit-lookup — resultados", () => {
    it("sin configuración (implementación real): 200 NOT_CONFIGURED, sin red", async () => {
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toContain("no-store");
        expect(await res.json()).toEqual({ status: "NOT_CONFIGURED", message: "Consulta ARCA no configurada" });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
    it("FOUND: devuelve fuente, fecha y datos; no crea ni modifica clientes", async () => {
        H.lookup = async () => ({ status: "FOUND", cuit: CUIT, source: "ARCA — fuente", consultedAt: "2026-10-25T12:00:00.000Z", person: PERSON });
        const before = JSON.stringify(world.clients);
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "FOUND", cuit: CUIT, source: "ARCA — fuente", consultedAt: "2026-10-25T12:00:00.000Z", person: PERSON });
        expect(JSON.stringify(world.clients)).toBe(before);
        expect(db.client.create).not.toHaveBeenCalled();
        expect(db.client.update).not.toHaveBeenCalled();
        expect(db.auditLog.create).not.toHaveBeenCalled();
    });
    it("NOT_FOUND: 200", async () => {
        H.lookup = async () => ({ status: "NOT_FOUND", cuit: CUIT });
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "NOT_FOUND", cuit: CUIT });
    });
    it.each([
        ["TIMEOUT", 504, "ARCA_TIMEOUT"],
        ["UNAVAILABLE", 502, "ARCA_UNAVAILABLE"],
        ["AUTH", 502, "ARCA_AUTH"],
        ["INVALID_RESPONSE", 502, "ARCA_INVALID_RESPONSE"],
    ])("error %s -> %i %s con mensaje claro", async (code, status, errCode) => {
        H.lookup = async () => ({ status: "ERROR", code });
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(status);
        const body = await res.json();
        expect(body.error.code).toBe(errCode);
        expect(body.error.message).toMatch(/manualmente|reintentar/);
    });
});

describe("POST /api/arca/cuit-lookup — límite de uso", () => {
    it("429 al superar el límite por usuario, con Retry-After; el rechazo no consulta", async () => {
        const spy = vi.fn(async () => ({ status: "NOT_FOUND", cuit: CUIT }));
        H.lookup = spy;
        for (let i = 0; i < 10; i++) expect((await lookup({ cuit: CUIT })).status).toBe(200);
        const res = await lookup({ cuit: CUIT });
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("60");
        expect((await res.json()).error.code).toBe("RATE_LIMITED");
        expect(spy).toHaveBeenCalledTimes(10);
    });
    it("un CUIT inválido no consume cupo", async () => {
        H.lookup = async () => ({ status: "NOT_FOUND", cuit: CUIT });
        for (let i = 0; i < 20; i++) await lookup({ cuit: "1" });
        expect((await lookup({ cuit: CUIT })).status).toBe(200);
    });
});

describe("POST /api/arca/cuit-lookup — sin datos en logs", () => {
    it("no escribe en consola el CUIT ni la respuesta", async () => {
        const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
        await lookup({ cuit: CUIT });
        H.lookup = async () => ({ status: "FOUND", cuit: CUIT, source: "s", consultedAt: "x", person: PERSON });
        await lookup({ cuit: CUIT });
        H.lookup = async () => ({ status: "ERROR", code: "AUTH" });
        await lookup({ cuit: CUIT });
        for (const s of spies) {
            for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toMatch(/44444444|SINTETICA/);
            s.mockRestore();
        }
    });
});
