import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Endpoints con los registros REALES (sin mockear): los catálogos sintéticos
 * sólo se sirven con las barreras habilitadas, sin desplazar los oficiales aprobados por el estudio.
 */
const H = vi.hoisted(() => ({
    claims: { value: null as unknown },
    db: { current: null as unknown },
}));
vi.mock("@/lib/auth/claims", () => ({ getAuthClaims: async () => H.claims.value }));
vi.mock("@/lib/prisma", () => ({
    get default() {
        return H.db.current;
    },
}));

import { freshDbMock, freshRecorder, wireDb, makeWorld, claimsFor, clientRow, SUB_OWNER_A, ORG_A } from "./_harness";
import { GET as LIST } from "@/app/api/activity-catalogs/route";
import { GET as SEARCH } from "@/app/api/activity-catalogs/search/route";
import { POST as SUGGEST } from "@/app/api/iibb-rates/suggest/route";
import { POST } from "@/app/api/clients/route";
import { DELETE } from "@/app/api/clients/[id]/route";
import { DEV_REF, PROD_REF } from "@/lib/preview-fixtures/gate";

const PW = "ClaveSintetica-NoReal-987";
const ENABLED = {
    CATALOG_FIXTURES_BUILD: "1",
    CATALOGOS_SINTETICOS: "1",
    CATALOGOS_SINTETICOS_HASTA: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
    DATABASE_URL: `postgresql://postgres.${DEV_REF}:${PW}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`,
    DIRECT_URL: `postgresql://postgres:${PW}@db.${DEV_REF}.supabase.co:5432/postgres`,
    NEXT_PUBLIC_SUPABASE_URL: `https://${DEV_REF}.supabase.co`,
};
function setEnv(env: Partial<Record<keyof typeof ENABLED | "CONTEXT", string | undefined>>) {
    vi.unstubAllEnvs();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
}

beforeEach(() => {
    const db = freshDbMock();
    const world = makeWorld({ clients: [clientRow("c_x", ORG_A, { defaultIibbRate: new Prisma.Decimal("3") })], periods: [] });
    wireDb(db, world, freshRecorder());
    H.db.current = db;
    H.claims.value = claimsFor(SUB_OWNER_A);
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

const listIds = async () => ((await (await LIST(new Request("http://localhost/api/activity-catalogs"))).json()) as { catalogs: Array<{ id: string }> }).catalogs.map((c) => c.id);
const searchCodes = async (q: string) =>
    ((await (await SEARCH(new Request(`http://localhost/api/activity-catalogs/search?q=${q}&nomenclator=NAES`))).json()) as { results: Array<{ entry: { code: string } }> }).results.map((r) => r.entry.code);
const suggestStatus = async () =>
    ((await (
        await SUGGEST(
            new Request("http://localhost/api/iibb-rates/suggest", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jurisdiction: "901", nomenclator: "NAES", catalogId: "prueba-sintetica-naes", code: "999001", date: "2026-03-01", registration: null, facts: {} }),
            }),
        )
    ).json()) as { suggestion: { status: string; alternative?: { rate: string } } }).suggestion;

const OFFICIAL = ["naes-rg-ca-19-2025", "clae-rg-afip-3537-2013", "arba-naiibb18-2026-10-27"];

describe("catálogos sintéticos en los endpoints", () => {
    it("barreras habilitadas: fixtures separados de los tres nomencladores oficiales", async () => {
        setEnv(ENABLED);
        const ids = await listIds();
        expect(ids.sort()).toEqual([...OFFICIAL, "prueba-sintetica-naes"].sort());
        expect(await searchCodes("999001")).toEqual(["999001"]);
        expect(await searchCodes("011111")).toEqual(["011111"]); // catálogo aprobado; sin reglas tributarias habilitadas
        expect(await suggestStatus()).toMatchObject({ status: "UNICA", alternative: { rate: "1.23" } });
    });
    it.each([
        ["build sin fixtures (constante «0»)", { ...ENABLED, CATALOG_FIXTURES_BUILD: "0" }],
        ["sin activación", { ...ENABLED, CATALOGOS_SINTETICOS: undefined }],
        ["activación vencida", { ...ENABLED, CATALOGOS_SINTETICOS_HASTA: "2020-01-01T00:00:00Z" }],
        ["base de PROD", { ...ENABLED, DATABASE_URL: `postgresql://postgres:${PW}@db.${PROD_REF}.supabase.co:5432/postgres` }],
        ["Supabase de PROD", { ...ENABLED, NEXT_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co` }],
        ["CONTEXT de producción", { ...ENABLED, CONTEXT: "production" }],
        ["sin variables (producción normal)", {}],
    ])("%s: nada sintético se sirve", async (_label, env) => {
        setEnv(env);
        expect((await listIds()).sort()).toEqual([...OFFICIAL].sort());
        expect(await searchCodes("999001")).toEqual([]);
        expect((await suggestStatus()).status).toBe("SIN_COBERTURA");
    });
    it("vencimiento en el mismo proceso: deja de servirse en la llamada siguiente, sin caché que lo prolongue", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
        setEnv({ ...ENABLED, CATALOGOS_SINTETICOS_HASTA: "2026-10-28T12:00:00Z" });
        expect((await listIds()).sort()).toEqual([...OFFICIAL, "prueba-sintetica-naes"].sort());
        expect(await searchCodes("999001")).toEqual(["999001"]);
        vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
        expect((await listIds()).sort()).toEqual([...OFFICIAL].sort());
        expect(await searchCodes("999001")).toEqual([]);
        expect((await suggestStatus()).status).toBe("SIN_COBERTURA");
    });
    it("guardar una actividad del catálogo sintético: aceptado sólo con las barreras habilitadas", async () => {
        const body = {
            name: "Cliente sintético",
            cuit: "30-99999917-0",
            condition: "Responsable Inscripto",
            phone: "+54 11 5555-0100",
            contactEmail: "contacto@estudio.test",
            iibb: {
                registration: "LOCAL",
                jurisdictions: [{ code: "901", headquarters: false }],
                activities: [
                    {
                        nomenclator: "NAES",
                        code: "999001",
                        description: "[PRUEBA] Servicios sintéticos de consultoría (no oficial)",
                        nomenclatorReference: "[PRUEBA] sin norma",
                        origin: "CATALOG",
                        catalogId: "prueba-sintetica-naes",
                        catalogVersion: "[PRUEBA] sintética",
                        rates: [],
                    },
                ],
            },
        };
        const send = () => POST(new Request("http://localhost/api/clients", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
        setEnv({});
        expect((await send()).status).toBe(422);
        setEnv(ENABLED);
        const created = await send();
        expect(created.status).toBe(201);
        // Limpieza con las barreras ya deshabilitadas: la baja no depende de los catálogos.
        const { id } = (await created.json()) as { id: string };
        setEnv({});
        const del = await DELETE(new Request(`http://localhost/api/clients/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
        expect(del.status).toBe(204);
    });
});
