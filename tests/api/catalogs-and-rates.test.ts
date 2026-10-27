import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const H = vi.hoisted(() => ({
    claims: { throw: null as unknown, value: null as unknown },
    db: { current: null as unknown },
    catalogs: [] as unknown[],
    rules: [] as unknown[],
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
// Catálogos y reglas SINTÉTICOS inyectados (no los datos oficiales pendientes).
vi.mock("@/lib/activity-catalog/registry", () => ({ activityCatalogs: () => H.catalogs }));
vi.mock("@/lib/iibb-rates/registry", async () => {
    const { withApprovedCatalog } = await import("@/lib/iibb-rates/suggest");
    return { rateRuleSets: () => H.rules, usableRateRuleSets: () => withApprovedCatalog(H.rules as RateRuleSet[], H.catalogs as CatalogFile[]) };
});

import type { RateRuleSet } from "@/lib/iibb-rates/types";
import type { CatalogFile } from "@/lib/activity-catalog/types";
import { freshDbMock, freshRecorder, wireDb, makeWorld, claimsFor, clientRow, SUB_OWNER_A, SUB_VIEWER_A, SUB_ACCOUNTANT_A, ORG_A, ORG_B } from "./_harness";
import { GET as LIST } from "@/app/api/activity-catalogs/route";
import { GET as SEARCH } from "@/app/api/activity-catalogs/search/route";
import { POST as SUGGEST } from "@/app/api/iibb-rates/suggest/route";
import { POST } from "@/app/api/clients/route";
import { PATCH } from "@/app/api/clients/[id]/route";
import { selectionFromEntry } from "@/lib/activity-catalog/types";
import { CLAE, NAES_PENDING, NAES_V1, PROV_921, rule, ruleSet } from "../_fixtures/catalogs";

const PHONE = "+54 11 5555-0100";
const EMAIL = "contacto@estudio.test";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: ReturnType<typeof makeWorld>;

beforeEach(() => {
    db = freshDbMock();
    rec = freshRecorder();
    world = makeWorld({
        clients: [
            clientRow("c_cat", ORG_A, { phone: PHONE, contactEmail: EMAIL, iibbRegistration: "LOCAL", defaultIibbRate: new Prisma.Decimal("4.5") }),
            clientRow("c_b", ORG_B),
        ],
        periods: [],
        clientJurisdictions: [{ id: "cj1", clientId: "c_cat", organizationId: ORG_A, jurisdictionCode: "901", isHeadquarters: false }],
        clientActivities: [
            // Copia de un catálogo que YA NO está publicado (retirado): debe poder conservarse.
            {
                id: "ca1",
                clientId: "c_cat",
                organizationId: ORG_A,
                nomenclator: "NAES",
                nomenclatorJurisdiction: "",
                nomenclatorReference: "Norma retirada",
                code: "620100",
                description: "Descripción de una versión anterior",
                origin: "CATALOG",
                catalogId: "catalogo-retirado",
                catalogVersion: "Vieja",
            },
        ],
        clientActivityRates: [
            { id: "r1", clientId: "c_cat", organizationId: ORG_A, activityId: "ca1", jurisdictionCode: "901", rate: null, treatment: "EXEMPT", rateOrigin: "STUDIO_MANUAL", ruleRef: null },
        ],
    });
    wireDb(db, world, rec);
    H.db.current = db;
    H.claims.throw = null;
    H.claims.value = claimsFor(SUB_OWNER_A);
    H.catalogs = [NAES_V1, CLAE, PROV_921, NAES_PENDING];
    H.rules = [ruleSet({ validFrom: "2000-01-01", validTo: null }, [rule({ id: "r1", rate: "3.5" })])];
});

const search = (qs: string) => SEARCH(new Request(`http://localhost/api/activity-catalogs/search?${qs}`));
const suggest = (body: unknown) =>
    SUGGEST(new Request("http://localhost/api/iibb-rates/suggest", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const post = (body: unknown) => POST(new Request("http://localhost/api/clients", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const versionOf = (id: string) => (world.clients.find((c) => c.id === id)?.updatedAt ?? new Date("2026-01-01T00:00:00.000Z")).toISOString();
const patch = (id: string, body: Record<string, unknown>) =>
    PATCH(
        new Request(`http://localhost/api/clients/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ expectedUpdatedAt: versionOf(id), ...body }),
            headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id }) },
    );

const naesSel = selectionFromEntry(NAES_V1.manifest, NAES_V1.entries.find((e) => e.code === "620100")!);
const catalogActivity = (over: Record<string, unknown> = {}) => ({
    nomenclator: naesSel.nomenclator,
    code: naesSel.code,
    description: naesSel.description,
    nomenclatorReference: naesSel.reference,
    origin: "CATALOG",
    catalogId: naesSel.catalogId,
    catalogVersion: naesSel.catalogVersion,
    rates: [],
    ...over,
});

describe("GET /api/activity-catalogs y /search", () => {
    it("sin sesión: 401; VIEWER puede buscar (sólo lectura de datos públicos)", async () => {
        H.claims.value = null;
        expect((await search("q=620100&nomenclator=NAES")).status).toBe(401);
        H.claims.value = claimsFor(SUB_VIEWER_A);
        expect((await search("q=620100&nomenclator=NAES")).status).toBe(200);
    });
    it("lista sólo versiones REVISADAS, con fuente, norma y vigencia", async () => {
        const res = await LIST(new Request("http://localhost/api/activity-catalogs"));
        const body = await res.json();
        expect(body.catalogs.map((c: { id: string }) => c.id).sort()).toEqual(["fixture-clae", "fixture-naes-v1", "fixture-prov-921"]);
        expect(body.catalogs[0]).toHaveProperty("sourceUrl");
        expect(res.headers.get("cache-control")).toMatch(/no-store/);
    });
    it("búsqueda por nomenclador: no mezcla códigos iguales de otros catálogos; pendientes nunca aparecen", async () => {
        const body = await (await search("q=620100&nomenclator=NAES&date=2026-01-15")).json();
        expect(body.results.map((r: { catalogId: string }) => r.catalogId)).toEqual(["fixture-naes-v1"]);
        const pending = await (await search("q=999999&nomenclator=NAES&date=2026-01-15&historical=1")).json();
        expect(pending.results).toEqual([]);
    });
    it("validación de parámetros: 422 con campo", async () => {
        expect((await search("nomenclator=NAES")).status).toBe(422);
        expect(await (await search("q=x&nomenclator=XYZ")).json()).toMatchObject({ field: "nomenclator" });
        expect(await (await search("q=620100&nomenclator=PROVINCIAL")).json()).toMatchObject({ field: "jurisdiction" });
        expect(await (await search("q=620100&nomenclator=NAES&date=2026-13-01")).json()).toMatchObject({ field: "date" });
        expect((await search(`q=${"x".repeat(81)}&nomenclator=NAES`)).status).toBe(422);
    });
});

describe("POST /api/iibb-rates/suggest", () => {
    const body = { jurisdiction: "901", nomenclator: "NAES", catalogId: "fixture-naes-v1", code: "620100", date: "2026-03-01", registration: "LOCAL" };
    it("OWNER/ACCOUNTANT consultan; VIEWER no (403)", async () => {
        H.claims.value = claimsFor(SUB_ACCOUNTANT_A);
        expect((await suggest(body)).status).toBe(200);
        H.claims.value = claimsFor(SUB_VIEWER_A);
        expect((await suggest(body)).status).toBe(403);
    });
    it("regla revisada única: UNICA con fuente; no escribe nada", async () => {
        const res = await (await suggest(body)).json();
        expect(res.suggestion).toMatchObject({ status: "UNICA", alternative: { ruleRef: "fixture-rules-901#r1", rate: "3.5", sourceUrl: "https://example.test/ley-2026.pdf" } });
        expect(rec.audits).toEqual([]);
        expect(db.client.update).not.toHaveBeenCalled();
    });
    it("sin reglas para la jurisdicción o para ARCA: «pendiente de determinar»", async () => {
        expect((await (await suggest({ ...body, jurisdiction: "920" })).json()).suggestion.status).toBe("SIN_COBERTURA");
        expect((await (await suggest({ ...body, nomenclator: "ARCA", catalogId: "fixture-clae" })).json()).suggestion.status).toBe("SIN_COBERTURA");
        H.rules = [];
        expect((await (await suggest(body)).json()).suggestion.status).toBe("SIN_COBERTURA");
    });
    it("datos del cliente en el CUERPO; formato inválido: 422", async () => {
        expect((await suggest({ ...body, facts: { priorYearGrossIncome: "1.000.000" } })).status).toBe(422);
        expect((await suggest({ ...body, facts: { priorYearGrossIncome: "1000000.50" } })).status).toBe(200);
        expect((await suggest({ ...body, jurisdiction: "999" })).status).toBe(422);
    });
});

describe("POST/PATCH /api/clients — procedencia y alícuota heredada", () => {
    const base = { name: "Nueva SA", cuit: "30-22222222-9", condition: "Responsable Inscripto", phone: PHONE, contactEmail: EMAIL };
    const profile = (activities: unknown[], over: Record<string, unknown> = {}) => ({
        registration: "LOCAL",
        jurisdictions: [{ code: "901" }],
        activities,
        ...over,
    });

    it("alta con actividad de catálogo revisado y sugerencia confirmada: guarda la copia, el origen y la regla", async () => {
        const res = await post({
            ...base,
            iibb: profile([catalogActivity({ rates: [{ jurisdiction: "901", rate: "3.5", treatment: "RATE", origin: "CONFIRMED_SUGGESTION", ruleRef: "fixture-rules-901#r1" }] })]),
        });
        expect(res.status).toBe(201);
        const act = world.clientActivities!.find((a) => a.code === "620100" && a.clientId !== "c_cat");
        expect(act).toMatchObject({ origin: "CATALOG", catalogId: "fixture-naes-v1", catalogVersion: "Prueba 1/2025", description: naesSel.description });
        const rate = world.clientActivityRates!.find((r) => r.activityId === act!.id);
        expect(rate).toMatchObject({ treatment: "RATE", rateOrigin: "CONFIRMED_SUGGESTION", ruleRef: "fixture-rules-901#r1" });
        expect(rate!.rate.toString()).toBe("3.5");
    });
    it("alta sin defaultIibbRate: valor inicial del contrato vigente (3); nunca vacío ni 0", async () => {
        const res = await post(base);
        expect(res.status).toBe(201);
        expect((await res.json()).defaultIibbRate).toBe("3");
    });
    it("alta con copia de catálogo alterada o catálogo pendiente: 422 en la fila", async () => {
        for (const act of [catalogActivity({ description: "Otra" }), catalogActivity({ catalogId: "fixture-naes-pending", code: "999999" })]) {
            const res = await post({ ...base, iibb: profile([act]) });
            expect(res.status).toBe(422);
            expect(await res.json()).toMatchObject({ field: "iibb.activities[0].code" });
        }
        expect(rec.audits).toEqual([]);
    });
    it("sugerencia con valor distinto de la regla: 422 en la alícuota", async () => {
        const res = await post({
            ...base,
            iibb: profile([catalogActivity({ rates: [{ jurisdiction: "901", rate: "5", treatment: "RATE", origin: "CONFIRMED_SUGGESTION", ruleRef: "fixture-rules-901#r1" }] })]),
        });
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ field: "iibb.activities[0].rates[0]" });
    });
    it("edición de contactos con una actividad de catálogo retirado guardada: se conserva sin cambios", async () => {
        const res = await patch("c_cat", { phone: "+54 11 5555-0199" });
        expect(res.status).toBe(200);
        expect(world.clientActivities!.find((a) => a.id === "ca1")).toMatchObject({ catalogId: "catalogo-retirado", description: "Descripción de una versión anterior" });
        expect(world.clientActivityRates!.find((r) => r.id === "r1")).toMatchObject({ treatment: "EXEMPT", rateOrigin: "STUDIO_MANUAL" });
    });
    it("reenvío de la ficha sin cambios (copia retirada incluida): sin escritura ni auditoría", async () => {
        const stored = {
            nomenclator: "NAES",
            code: "620100",
            description: "Descripción de una versión anterior",
            nomenclatorReference: "Norma retirada",
            origin: "CATALOG",
            catalogId: "catalogo-retirado",
            catalogVersion: "Vieja",
            rates: [{ jurisdiction: "901", rate: null, treatment: "EXEMPT", origin: "STUDIO_MANUAL" }],
        };
        const res = await patch("c_cat", { iibb: profile([stored]) });
        expect(res.status).toBe(200);
        expect(rec.audits).toEqual([]);
    });
    it("editar la ficha NO envía ni modifica defaultIibbRate (alícuota heredada preservada)", async () => {
        const res = await patch("c_cat", { iibb: profile([catalogActivity({ code: "620900", description: NAES_V1.entries[2].description, nomenclatorReference: "Norma de prueba 1/2025 · Sección J" })]) });
        // Cambia la actividad: hace falta confirmar la quita de la guardada.
        expect(res.status).toBe(422);
        const ok = await patch("c_cat", {
            iibb: {
                ...profile([catalogActivity({ code: "620900", description: NAES_V1.entries[2].description, nomenclatorReference: "Norma de prueba 1/2025 · Sección J" })]),
                confirmRemovedActivities: [{ key: "NAES||620100", jurisdictions: ["901"] }],
            },
        });
        expect(ok.status).toBe(200);
        expect(world.clients.find((c) => c.id === "c_cat")!.defaultIibbRate.toString()).toBe("4.5");
        expect(rec.audits.at(-1)?.metadata.changedFields).toBe("iibbProfile");
    });
    it("aislamiento por organización: la otra organización no edita ni ve el cliente (404)", async () => {
        H.claims.value = claimsFor("bbbbbbbb-0000-4000-8000-000000000001");
        expect((await patch("c_cat", { phone: "+54 11 5555-0199" })).status).toBe(404);
    });
});
