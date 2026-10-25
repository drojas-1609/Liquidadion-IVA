import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const H = vi.hoisted(() => ({
    claims: { throw: null as unknown, value: null as unknown },
    db: { current: null as unknown },
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

import {
    freshDbMock,
    freshRecorder,
    wireDb,
    makeWorld,
    claimsFor,
    clientRow,
    SUB_OWNER_A,
    SUB_OWNER_B,
    SUB_ACCOUNTANT_A,
    ORG_A,
    ORG_B,
} from "./_harness";
import { POST } from "@/app/api/clients/route";
import { PATCH } from "@/app/api/clients/[id]/route";

// Datos SINTÉTICOS (no corresponden a personas reales).
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
            // Cliente histórico: sin contactos ni inscripción.
            clientRow("c_hist", ORG_A, { address: "Calle 1" }),
            // Cliente con ficha completa.
            clientRow("c_full", ORG_A, { phone: PHONE, contactEmail: EMAIL, iibbRegistration: "CONVENIO_MULTILATERAL" }),
            clientRow("c_b", ORG_B),
        ],
        periods: [],
        clientJurisdictions: [
            { id: "cj1", clientId: "c_full", organizationId: ORG_A, jurisdictionCode: "901", isHeadquarters: true },
            { id: "cj2", clientId: "c_full", organizationId: ORG_A, jurisdictionCode: "902", isHeadquarters: false },
            { id: "cj3", clientId: "c_full", organizationId: ORG_A, jurisdictionCode: "921", isHeadquarters: false },
        ],
        clientActivities: [
            { id: "ca1", clientId: "c_full", organizationId: ORG_A, nomenclator: "NAES", nomenclatorJurisdiction: "", nomenclatorReference: null, code: "620100", description: "Servicios de prueba" },
        ],
        clientActivityRates: [
            { id: "r1", clientId: "c_full", organizationId: ORG_A, activityId: "ca1", jurisdictionCode: "901", rate: new Prisma.Decimal("3.5") },
            { id: "r2", clientId: "c_full", organizationId: ORG_A, activityId: "ca1", jurisdictionCode: "902", rate: null },
        ],
    });
    wireDb(db, world, rec);
    H.db.current = db;
    H.claims.throw = null;
    H.claims.value = claimsFor(SUB_OWNER_A);
});

const jbody = (o: unknown) => JSON.stringify(o);
const post = (body: unknown) =>
    POST(new Request("http://localhost/api/clients", { method: "POST", body: jbody(body), headers: { "content-type": "application/json" } }));
/** Versión actual del cliente en el mundo simulado (formulario recién abierto). */
const versionOf = (id: string) => (world.clients.find((c) => c.id === id)?.updatedAt ?? new Date("2026-01-01T00:00:00.000Z")).toISOString();
/** PATCH con la versión vigente salvo que el body traiga `expectedUpdatedAt` (formularios viejos, ausente, inválido). */
const patch = (id: string, body: unknown) =>
    PATCH(
        new Request(`http://localhost/api/clients/${id}`, {
            method: "PATCH",
            body: jbody(typeof body === "object" && body !== null && !("expectedUpdatedAt" in body) ? { ...body, expectedUpdatedAt: versionOf(id) } : body),
            headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id }) },
    );
/** activityKey de la actividad guardada de c_full. */
const NAES_KEY = "NAES||620100";
const valid = { name: "Nueva SA", cuit: "30-22222222-9", condition: "Responsable Inscripto", phone: PHONE, contactEmail: EMAIL };
const fullProfile = {
    registration: "CONVENIO_MULTILATERAL",
    jurisdictions: [{ code: "901", headquarters: true }, { code: "902" }, { code: "921" }],
    activities: [
        {
            nomenclator: "NAES",
            code: "620100",
            description: "Servicios de prueba",
            rates: [{ jurisdiction: "901", rate: "3.5" }, { jurisdiction: "902", rate: null }],
        },
    ],
};
const storedOf = (clientId: string) => ({
    jurisdictions: world.clientJurisdictions!.filter((j) => j.clientId === clientId).map((j) => [j.jurisdictionCode, j.isHeadquarters]).sort(),
    activities: world.clientActivities!.filter((a) => a.clientId === clientId).map((a) => a.code).sort(),
    rates: world.clientActivityRates!
        .filter((r) => r.clientId === clientId)
        .map((r) => [r.jurisdictionCode, r.rate === null ? null : r.rate.toString()])
        .sort(),
});

describe("POST /api/clients — contactos", () => {
    it("201 con teléfono y email; el DTO los expone y la auditoría NO", async () => {
        const res = await post(valid);
        expect(res.status).toBe(201);
        const dto = await res.json();
        expect(dto).toMatchObject({ phone: PHONE, contactEmail: EMAIL, iibbRegistration: null, defaultIibbRate: "3" });
        expect(rec.created.client).toMatchObject({ phone: PHONE, contactEmail: EMAIL, iibbRegistration: null });
        expect(rec.audits[0].metadata).toEqual({ condition: "Responsable Inscripto", iibbRegistration: null });
        expect(JSON.stringify(rec.audits)).not.toMatch(/5555|estudio\.test/);
    });

    it.each([
        ["sin teléfono", { phone: undefined }, "phone"],
        ["teléfono vacío", { phone: "  " }, "phone"],
        ["teléfono inválido", { phone: "tel. 123" }, "phone"],
        ["sin email", { contactEmail: undefined }, "contactEmail"],
        ["email inválido", { contactEmail: "sin-arroba" }, "contactEmail"],
    ])("%s -> 422 sin escritura", async (_l, over, field) => {
        const res = await post({ ...valid, ...over });
        expect(res.status).toBe(422);
        expect((await res.json()).field).toBe(field);
        expect(db.client.create).not.toHaveBeenCalled();
        expect(rec.audits).toHaveLength(0);
    });

    it("contactos compartidos entre clientes: permitido (sin unicidad global)", async () => {
        expect((await post(valid)).status).toBe(201);
        expect((await post({ ...valid, cuit: "30-44444444-0", name: "Otra SA" })).status).toBe(201);
    });
});

describe("POST /api/clients — perfil IIBB informativo", () => {
    it("sin inscripción: queda sin clasificar y sin jurisdicciones", async () => {
        const res = await post(valid);
        const dto = await res.json();
        expect(dto.iibbRegistration).toBeNull();
        expect(db.clientJurisdiction.createMany).not.toHaveBeenCalled();
    });

    it("guarda inscripción, jurisdicciones, actividades y alícuotas (0 explícito distinto de sin informar)", async () => {
        const res = await post({
            ...valid,
            defaultIibbRate: "2.5",
            iibb: {
                ...fullProfile,
                activities: [
                    { ...fullProfile.activities[0], rates: [{ jurisdiction: "901", rate: "0" }, { jurisdiction: "902", rate: null }] },
                    { nomenclator: "ARCA", code: "702092", description: "Otra actividad", rates: [{ jurisdiction: "921", rate: "4.25" }] },
                ],
            },
        });
        expect(res.status).toBe(201);
        const dto = await res.json();
        expect(dto).toMatchObject({ iibbRegistration: "CONVENIO_MULTILATERAL", defaultIibbRate: "2.5" });
        const created = world.clients.find((c) => c.cuit === "30-22222222-9")!;
        expect(storedOf(created.id)).toEqual({
            jurisdictions: [["901", true], ["902", false], ["921", false]],
            activities: ["620100", "702092"],
            rates: [["901", "0"], ["902", null], ["921", "4.25"]],
        });
        // La alícuota heredada NO se toca ni se reparte.
        expect(created.defaultIibbRate.toString()).toBe("2.5");
        expect(rec.audits[0].metadata).toEqual({ condition: "Responsable Inscripto", iibbRegistration: "CONVENIO_MULTILATERAL" });
        expect(JSON.stringify(rec.audits)).not.toMatch(/620100|702092|4\.25|901/);
    });

    it("perfil incoherente -> 422 y rollback (ni cliente ni ficha)", async () => {
        const res = await post({ ...valid, iibb: { registration: "LOCAL", jurisdictions: [{ code: "901" }, { code: "902" }] } });
        expect(res.status).toBe(422);
        expect((await res.json()).field).toBe("iibb.jurisdictions");
        expect(db.client.create).not.toHaveBeenCalled();
    });

    it("si falla la auditoría: rollback completo (cliente y ficha)", async () => {
        rec.failAudit = true;
        const before = world.clients.length;
        const res = await post({ ...valid, iibb: fullProfile });
        expect(res.status).toBe(500);
        expect(world.clients).toHaveLength(before);
        expect(world.clientJurisdictions!.filter((j) => j.clientId !== "c_full")).toHaveLength(0);
        expect(world.clientActivityRates!.filter((r) => r.clientId !== "c_full")).toHaveLength(0);
    });

    it("ignora organizationId del body: la ficha se crea en la organización del usuario", async () => {
        const res = await post({ ...valid, organizationId: ORG_B, iibb: fullProfile });
        expect(res.status).toBe(201);
        for (const rows of [world.clientJurisdictions!, world.clientActivities!, world.clientActivityRates!]) {
            expect(rows.every((r) => r.organizationId === ORG_A)).toBe(true);
        }
    });
});

describe("PATCH /api/clients/[id] — contactos de clientes históricos", () => {
    it("editar otro campo sin contactos: permitido (vacío no es cambio)", async () => {
        const res = await patch("c_hist", { name: "Renombrado SA", phone: "", contactEmail: "" });
        expect(res.status).toBe(200);
        const dto = await res.json();
        expect(dto).toMatchObject({ name: "Renombrado SA", phone: null, contactEmail: null });
        expect(rec.audits[0].metadata.changedFields).toBe("name");
    });

    it("completar contactos pendientes", async () => {
        const res = await patch("c_hist", { phone: PHONE, contactEmail: EMAIL });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ phone: PHONE, contactEmail: EMAIL });
        expect(rec.audits[0].metadata.changedFields).toBe("phone,contactEmail");
        expect(JSON.stringify(rec.audits)).not.toMatch(/5555|estudio\.test/);
    });

    it.each([
        ["vaciar teléfono confirmado", { phone: "" }, "phone"],
        ["vaciar email confirmado (null)", { contactEmail: null }, "contactEmail"],
    ])("%s -> 422 sin escritura", async (_l, body, field) => {
        const res = await patch("c_full", body);
        expect(res.status).toBe(422);
        expect((await res.json()).field).toBe(field);
        expect(db.client.update).not.toHaveBeenCalled();
        expect(world.clients.find((c) => c.id === "c_full")!.phone).toBe(PHONE);
    });

    it("campos ausentes no cambian (edición parcial)", async () => {
        const res = await patch("c_full", { address: "Nueva 123" });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ phone: PHONE, contactEmail: EMAIL, iibbRegistration: "CONVENIO_MULTILATERAL", address: "Nueva 123" });
        expect(db.clientJurisdiction.deleteMany).not.toHaveBeenCalled();
    });

    it("formato inválido -> 422", async () => {
        expect((await patch("c_full", { contactEmail: "x@" })).status).toBe(422);
        expect((await patch("c_full", { phone: "12" })).status).toBe(422);
    });
});

describe("PATCH /api/clients/[id] — perfil IIBB", () => {
    it("perfil sin cambios: ni escritura ni AuditLog", async () => {
        const res = await patch("c_full", { iibb: fullProfile });
        expect(res.status).toBe(200);
        expect(db.client.update).not.toHaveBeenCalled();
        expect(db.clientJurisdiction.deleteMany).not.toHaveBeenCalled();
        expect(rec.audits).toHaveLength(0);
    });

    it("cambiar alícuotas y agregar actividad: reemplazo completo, defaultIibbRate intacto", async () => {
        const res = await patch("c_full", {
            iibb: {
                ...fullProfile,
                activities: [
                    { ...fullProfile.activities[0], rates: [{ jurisdiction: "901", rate: "4" }, { jurisdiction: "921", rate: "0" }] },
                    { nomenclator: "PROVINCIAL", nomenclatorJurisdiction: "904", code: "6201", description: "Actividad provincial", rates: [] },
                ],
            },
        });
        expect(res.status).toBe(200);
        expect(storedOf("c_full")).toEqual({
            jurisdictions: [["901", true], ["902", false], ["921", false]],
            activities: ["6201", "620100"],
            rates: [["901", "4"], ["921", "0"]],
        });
        expect(world.clients.find((c) => c.id === "c_full")!.defaultIibbRate.toString()).toBe("3");
        expect(rec.audits[0].metadata).toEqual({ changedFields: "iibbProfile", condition: "Responsable Inscripto", iibbRegistration: "CONVENIO_MULTILATERAL" });
    });

    it("quitar una jurisdicción con alícuotas asociadas SIN confirmar -> 422, nada se borra", async () => {
        const before = storedOf("c_full");
        const res = await patch("c_full", {
            iibb: {
                registration: "CONVENIO_MULTILATERAL",
                jurisdictions: [{ code: "901", headquarters: true }, { code: "921" }],
                activities: [{ ...fullProfile.activities[0], rates: [{ jurisdiction: "901", rate: "3.5" }] }],
            },
        });
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.field).toBe("iibb.confirmRemovedJurisdictions");
        expect(body.error.message).toMatch(/902/);
        expect(storedOf("c_full")).toEqual(before);
        expect(rec.audits).toHaveLength(0);
    });

    it("con confirmación explícita: se quita la jurisdicción y sus asociaciones", async () => {
        const res = await patch("c_full", {
            iibb: {
                registration: "CONVENIO_MULTILATERAL",
                jurisdictions: [{ code: "901", headquarters: true }, { code: "921" }],
                activities: [{ ...fullProfile.activities[0], rates: [{ jurisdiction: "901", rate: "3.5" }] }],
                confirmRemovedJurisdictions: [{ code: "902", associations: [NAES_KEY] }],
            },
        });
        expect(res.status).toBe(200);
        expect(storedOf("c_full").jurisdictions).toEqual([["901", true], ["921", false]]);
        expect(storedOf("c_full").rates).toEqual([["901", "3.5"]]);
    });

    it("quitar una actividad guardada exige confirmación", async () => {
        const iibb = { ...fullProfile, activities: [] };
        const res = await patch("c_full", { iibb });
        expect(res.status).toBe(422);
        expect((await res.json()).field).toBe("iibb.confirmRemovedActivities");
        const ok = await patch("c_full", { iibb: { ...iibb, confirmRemovedActivities: [{ key: NAES_KEY, jurisdictions: ["901", "902"] }] } });
        expect(ok.status).toBe(200);
        expect(storedOf("c_full").activities).toEqual([]);
    });

    it("cambio de régimen incoherente no elimina en silencio: CM con 3 jurisdicciones -> Local requiere dejar una", async () => {
        const res = await patch("c_full", { iibb: { ...fullProfile, registration: "LOCAL" } });
        expect(res.status).toBe(422);
        expect((await res.json()).field).toBe("iibb.jurisdictions");
        expect(storedOf("c_full").jurisdictions).toHaveLength(3);
    });

    it("cambio de régimen válido: registra iibbRegistration y NO cambia defaultIibbRate", async () => {
        const res = await patch("c_full", {
            defaultIibbRate: "3",
            iibb: {
                registration: "LOCAL",
                jurisdictions: [{ code: "901" }],
                activities: [{ ...fullProfile.activities[0], rates: [{ jurisdiction: "901", rate: "3.5" }] }],
                confirmRemovedJurisdictions: [{ code: "902", associations: [NAES_KEY] }],
            },
        });
        expect(res.status).toBe(200);
        const dto = await res.json();
        expect(dto).toMatchObject({ iibbRegistration: "LOCAL", defaultIibbRate: "3" });
        expect(rec.audits[0].metadata.changedFields).toBe("iibbRegistration,iibbProfile");
    });

    it("clasificar un cliente histórico", async () => {
        const res = await patch("c_hist", { iibb: { registration: "SIMPLIFICADO", jurisdictions: [{ code: "913" }] } });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ iibbRegistration: "SIMPLIFICADO" });
        expect(storedOf("c_hist").jurisdictions).toEqual([["913", false]]);
    });

    it("perfil de otra organización: 404, sin leer ni escribir su ficha", async () => {
        H.claims.value = claimsFor(SUB_OWNER_B);
        const res = await patch("c_full", { iibb: fullProfile });
        expect(res.status).toBe(404);
        expect(db.clientJurisdiction.deleteMany).not.toHaveBeenCalled();
        expect(storedOf("c_full").jurisdictions).toHaveLength(3);
    });

    it("ACCOUNTANT no edita la ficha (403), igual que el resto del cliente", async () => {
        H.claims.value = claimsFor(SUB_ACCOUNTANT_A);
        expect((await patch("c_full", { iibb: fullProfile })).status).toBe(403);
    });

    it("la base rechaza una alícuota que apunte a una jurisdicción de otro cliente (FK compuesta)", async () => {
        // Simulación directa de la integridad: el harness reproduce la FK compuesta.
        await expect(
            db.clientActivityRate.createMany({
                data: [{ clientId: "c_full", organizationId: ORG_A, activityId: "ca1", jurisdictionCode: "913", rate: null }],
            }),
        ).rejects.toMatchObject({ code: "P2003" });
        await expect(
            db.clientJurisdiction.createMany({ data: [{ clientId: "c_full", organizationId: ORG_B, jurisdictionCode: "913", isHeadquarters: false }] }),
        ).rejects.toMatchObject({ code: "P2003" });
    });
});
