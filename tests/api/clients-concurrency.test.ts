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

import { freshDbMock, freshRecorder, wireDb, makeWorld, claimsFor, clientRow, SUB_OWNER_A, SUB_OWNER_B, ORG_A, ORG_B } from "./_harness";
import { PATCH } from "@/app/api/clients/[id]/route";

/**
 * Concurrencia optimista de la edición de clientes (campos generales,
 * contactos y ficha IIBB): FOR UPDATE de la fila por id + organización,
 * versión `expectedUpdatedAt` (Client.updatedAt) verificada ANTES de cualquier
 * escritura o auditoría, y versión estrictamente creciente en cada escritura.
 * Datos SINTÉTICOS.
 */

const PHONE = "+54 11 5555-0100";
const EMAIL = "contacto@estudio.test";
const V0 = "2026-01-01T00:00:00.000Z";
const NAES_KEY = "NAES||620100";
const ARCA_KEY = "ARCA||702092";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: ReturnType<typeof makeWorld>;

beforeEach(() => {
    db = freshDbMock();
    rec = freshRecorder();
    world = makeWorld({
        clients: [
            clientRow("c_hist", ORG_A, { address: "Calle 1" }),
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

const patch = (id: string, body: unknown) =>
    PATCH(
        new Request(`http://localhost/api/clients/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        { params: Promise.resolve({ id }) },
    );
const client = (id: string) => world.clients.find((c) => c.id === id)!;
const versionOf = (id: string) => client(id).updatedAt.toISOString();

/** Ficha tal como la cargó un formulario abierto en V0. */
const NAES = { nomenclator: "NAES", code: "620100", description: "Servicios de prueba" };
const profileV0 = () => ({
    registration: "CONVENIO_MULTILATERAL",
    jurisdictions: [{ code: "901", headquarters: true }, { code: "902" }, { code: "921" }],
    activities: [{ ...NAES, rates: [{ jurisdiction: "901", rate: "3.5" }, { jurisdiction: "902", rate: null }] }],
});
/** Estado persistido completo del cliente (para verificar "sin escrituras"). */
const snapshot = (id: string) =>
    JSON.stringify({
        client: client(id),
        j: world.clientJurisdictions!.filter((x) => x.clientId === id),
        a: world.clientActivities!.filter((x) => x.clientId === id),
        r: world.clientActivityRates!.filter((x) => x.clientId === id).map((x) => ({ ...x, rate: x.rate?.toString() ?? null })),
    });

async function expectStale(res: Response) {
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.field).toBe("expectedUpdatedAt");
    expect(body.error.message).toMatch(/modificado por otra persona/);
}

describe("versión ausente, inválida u obsoleta", () => {
    it.each([
        ["ausente", undefined],
        ["sin milisegundos", "2026-01-01T00:00:00Z"],
        ["sólo fecha", "2026-01-01"],
        ["no es fecha", "ayer"],
        ["número", 1767225600000],
        ["fecha inexistente", "2026-02-30T00:00:00.000Z"],
    ])("%s -> 422 expectedUpdatedAt, sin bloqueo ni escrituras", async (_l, v) => {
        const before = snapshot("c_full");
        const res = await patch("c_full", { name: "Otro", expectedUpdatedAt: v });
        expect(res.status).toBe(422);
        expect((await res.json()).field).toBe("expectedUpdatedAt");
        expect(rec.locks).toHaveLength(0);
        expect(snapshot("c_full")).toBe(before);
        expect(rec.audits).toHaveLength(0);
    });

    it("obsoleta -> 409 CONFLICT con field expectedUpdatedAt; sin escrituras ni AuditLog", async () => {
        const before = snapshot("c_full");
        const res = await patch("c_full", { name: "Otro", expectedUpdatedAt: "2025-12-31T23:59:59.999Z" });
        await expectStale(res);
        expect(db.client.update).not.toHaveBeenCalled();
        expect(db.clientJurisdiction.deleteMany).not.toHaveBeenCalled();
        expect(snapshot("c_full")).toBe(before);
        expect(rec.audits).toHaveLength(0);
    });

    it("una versión FUTURA tampoco se acepta (igualdad exacta)", async () => {
        await expectStale(await patch("c_full", { name: "Otro", expectedUpdatedAt: "2026-01-01T00:00:00.001Z" }));
    });

    it("obsoleta aunque el cuerpo no cambie nada: igual 409 (el formulario está desactualizado)", async () => {
        await expectStale(await patch("c_full", { name: client("c_full").name, expectedUpdatedAt: "2025-01-01T00:00:00.000Z" }));
    });
});

describe("protocolo: bloqueo por organización y cliente antes de leer o escribir", () => {
    it("FOR UPDATE de Client con id + organización activa, antes de la lectura, la ficha y las escrituras", async () => {
        const res = await patch("c_full", { name: "Nuevo", iibb: { ...profileV0(), activities: [{ ...NAES, rates: [{ jurisdiction: "901", rate: "4" }, { jurisdiction: "902", rate: null }] }] }, expectedUpdatedAt: V0 });
        expect(res.status).toBe(200);
        expect(rec.rawSteps).toEqual(["lock:Client@0"]);
        expect(rec.locks[0].values).toEqual(["c_full", ORG_A]);
        const lockOrder = db.$queryRaw.mock.invocationCallOrder[0];
        for (const m of [db.client.findFirst, db.clientJurisdiction.findMany, db.client.update, db.clientActivityRate.deleteMany, db.auditLog.create]) {
            expect(m.mock.invocationCallOrder[0]).toBeGreaterThan(lockOrder);
        }
        // Opciones por defecto de Prisma: las { maxWait: 5000, timeout: 10000 } están reservadas a los writers del período.
        expect(rec.txOptions).toEqual([undefined]);
    });

    it("cliente de OTRA organización con su versión correcta -> 404 idéntico a inexistente; la versión no se revela", async () => {
        H.claims.value = claimsFor(SUB_OWNER_B);
        const before = snapshot("c_full");
        const other = await patch("c_full", { name: "X", expectedUpdatedAt: V0 });
        const missing = await patch("no-existe", { name: "X", expectedUpdatedAt: V0 });
        expect(other.status).toBe(404);
        expect(await other.json()).toEqual(await missing.json());
        expect(rec.locks[0].values).toEqual(["c_full", ORG_B]);
        expect(snapshot("c_full")).toBe(before);
        expect(rec.audits).toHaveLength(0);
    });

    it("con una versión obsoleta, otra organización igual recibe 404 (no 409)", async () => {
        H.claims.value = claimsFor(SUB_OWNER_B);
        expect((await patch("c_full", { name: "X", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" })).status).toBe(404);
    });
});

describe("dos formularios abiertos sobre la misma versión", () => {
    // Cambios que guarda primero el formulario A (abierto en V0).
    const firstChanges: Array<[string, () => Record<string, unknown>, (id: string) => void]> = [
        [
            "agrega una jurisdicción sin asociaciones",
            () => ({ iibb: { ...profileV0(), jurisdictions: [...profileV0().jurisdictions, { code: "904" }] } }),
            (id) => expect(world.clientJurisdictions!.some((j) => j.clientId === id && j.jurisdictionCode === "904")).toBe(true),
        ],
        [
            "agrega una asociación",
            () => ({ iibb: { ...profileV0(), activities: [{ ...NAES, rates: [...profileV0().activities[0].rates, { jurisdiction: "921", rate: "1" }] }] } }),
            (id) => expect(world.clientActivityRates!.some((r) => r.clientId === id && r.jurisdictionCode === "921")).toBe(true),
        ],
        [
            "cambia una alícuota (incluido 0 explícito)",
            () => ({ iibb: { ...profileV0(), activities: [{ ...NAES, rates: [{ jurisdiction: "901", rate: "3.5" }, { jurisdiction: "902", rate: "0" }] }] } }),
            (id) => expect(world.clientActivityRates!.find((r) => r.clientId === id && r.jurisdictionCode === "902")!.rate?.toString()).toBe("0"),
        ],
        [
            "cambia la inscripción",
            () => ({ iibb: { ...profileV0(), registration: "EXENTO", jurisdictions: profileV0().jurisdictions.map((j) => ({ code: j.code })) } }),
            (id) => expect(client(id).iibbRegistration).toBe("EXENTO"),
        ],
    ];
    // Lo que intenta guardar después el formulario B (también abierto en V0).
    const staleAttempts: Array<[string, () => Record<string, unknown>]> = [
        ["sólo el nombre", () => ({ name: "Nombre desde ficha vieja" })],
        ["su ficha IIBB vieja completa", () => ({ name: "Nombre desde ficha vieja", iibb: profileV0() })],
        ["sólo un contacto", () => ({ phone: "+54 11 5555-0199" })],
        ["sólo la alícuota del cálculo actual", () => ({ defaultIibbRate: "4" })],
    ];

    for (const [firstLabel, first, preserved] of firstChanges) {
        for (const [attemptLabel, attempt] of staleAttempts) {
            it(`A ${firstLabel}; B guarda ${attemptLabel} -> 409 y lo de A se conserva`, async () => {
                const a = await patch("c_full", { ...first(), expectedUpdatedAt: V0 });
                expect(a.status).toBe(200);
                expect(rec.audits).toHaveLength(1);
                const afterA = snapshot("c_full");

                const b = await patch("c_full", { ...attempt(), expectedUpdatedAt: V0 });
                await expectStale(b);
                expect(snapshot("c_full")).toBe(afterA);
                preserved("c_full");
                expect(rec.audits).toHaveLength(1); // sólo la de A
            });
        }
    }

    it("tras recargar (versión nueva) B puede guardar; el token no se renueva solo", async () => {
        expect((await patch("c_full", { name: "Por A", expectedUpdatedAt: V0 })).status).toBe(200);
        await expectStale(await patch("c_full", { name: "Por B", expectedUpdatedAt: V0 }));
        await expectStale(await patch("c_full", { name: "Por B", expectedUpdatedAt: V0 })); // reintento: sigue 409
        expect(client("c_full").name).toBe("Por A");
        const reloaded = versionOf("c_full");
        expect((await patch("c_full", { name: "Por B", expectedUpdatedAt: reloaded })).status).toBe(200);
        expect(client("c_full").name).toBe("Por B");
    });
});

describe("confirmación previa a una incorporación concurrente", () => {
    // El formulario A, abierto en V0, confirmó quitar 902 viendo SÓLO la asociación NAES.
    const removal902 = () => ({
        registration: "CONVENIO_MULTILATERAL",
        jurisdictions: [{ code: "901", headquarters: true }, { code: "921" }],
        activities: [{ ...NAES, rates: [{ jurisdiction: "901", rate: "3.5" }] }],
        confirmRemovedJurisdictions: [{ code: "902", associations: [NAES_KEY] }],
    });
    // Mientras tanto B agrega otra actividad asociada a 902.
    const addArcaOn902 = () => ({
        iibb: { ...profileV0(), activities: [...profileV0().activities, { nomenclator: "ARCA", code: "702092", description: "Otra", rates: [{ jurisdiction: "902", rate: "2" }] }] },
    });

    it("con la versión vieja: 409, no se borra nada de lo agregado", async () => {
        expect((await patch("c_full", { ...addArcaOn902(), expectedUpdatedAt: V0 })).status).toBe(200);
        const afterB = snapshot("c_full");
        await expectStale(await patch("c_full", { iibb: removal902(), expectedUpdatedAt: V0 }));
        expect(snapshot("c_full")).toBe(afterB);
    });

    it("aun con la versión vigente, una confirmación de OTRO conjunto no alcanza: 422 y nada se borra", async () => {
        expect((await patch("c_full", { ...addArcaOn902(), expectedUpdatedAt: V0 })).status).toBe(200);
        const afterB = snapshot("c_full");
        const res = await patch("c_full", {
            iibb: { ...removal902(), activities: [{ ...NAES, rates: [{ jurisdiction: "901", rate: "3.5" }] }, { nomenclator: "ARCA", code: "702092", description: "Otra" }] },
            expectedUpdatedAt: versionOf("c_full"),
        });
        expect(res.status).toBe(422);
        expect((await res.json()).field).toBe("iibb.confirmRemovedJurisdictions");
        expect(snapshot("c_full")).toBe(afterB);
        expect(rec.audits).toHaveLength(1);
    });

    it("con la confirmación del conjunto exacto y la versión vigente: se aplica", async () => {
        expect((await patch("c_full", { ...addArcaOn902(), expectedUpdatedAt: V0 })).status).toBe(200);
        const res = await patch("c_full", {
            iibb: {
                ...removal902(),
                activities: [{ ...NAES, rates: [{ jurisdiction: "901", rate: "3.5" }] }, { nomenclator: "ARCA", code: "702092", description: "Otra" }],
                confirmRemovedJurisdictions: [{ code: "902", associations: [ARCA_KEY, NAES_KEY] }],
            },
            expectedUpdatedAt: versionOf("c_full"),
        });
        expect(res.status).toBe(200);
        expect(world.clientJurisdictions!.filter((j) => j.clientId === "c_full").map((j) => j.jurisdictionCode).sort()).toEqual(["901", "921"]);
    });
});

describe("secuencias de quita (B1) contra el servidor", () => {
    it("quitar primero la actividad y después su jurisdicción: ambas confirmaciones exactas -> 200", async () => {
        const res = await patch("c_full", {
            iibb: {
                registration: "CONVENIO_MULTILATERAL",
                jurisdictions: [{ code: "901", headquarters: true }, { code: "921" }],
                activities: [],
                confirmRemovedActivities: [{ key: NAES_KEY, jurisdictions: ["901", "902"] }],
                confirmRemovedJurisdictions: [{ code: "902", associations: [NAES_KEY] }],
            },
            expectedUpdatedAt: V0,
        });
        expect(res.status).toBe(200);
        expect(world.clientActivities!.filter((a) => a.clientId === "c_full")).toHaveLength(0);
        expect(world.clientActivityRates!.filter((r) => r.clientId === "c_full")).toHaveLength(0);
    });

    it("quitar primero la asociación y después la jurisdicción: la confirmación incluye la asociación guardada", async () => {
        const iibb = {
            registration: "CONVENIO_MULTILATERAL",
            jurisdictions: [{ code: "901", headquarters: true }, { code: "921" }],
            activities: [{ ...NAES, rates: [{ jurisdiction: "901", rate: "3.5" }] }],
        };
        const missing = await patch("c_full", { iibb: { ...iibb, confirmRemovedJurisdictions: [] }, expectedUpdatedAt: V0 });
        expect(missing.status).toBe(422);
        const ok = await patch("c_full", { iibb: { ...iibb, confirmRemovedJurisdictions: [{ code: "902", associations: [NAES_KEY] }] }, expectedUpdatedAt: V0 });
        expect(ok.status).toBe(200);
    });
});

describe("rollback, auditoría única y versión monotónica", () => {
    it("falla el AuditLog -> 500 y rollback completo: cliente, versión y ficha intactos", async () => {
        rec.failAudit = true;
        const before = snapshot("c_full");
        const res = await patch("c_full", { name: "X", iibb: { ...profileV0(), registration: "EXENTO", jurisdictions: [{ code: "901" }, { code: "902" }, { code: "921" }] }, expectedUpdatedAt: V0 });
        expect(res.status).toBe(500);
        expect(snapshot("c_full")).toBe(before);
        expect(versionOf("c_full")).toBe(V0);
    });

    it("un solo AuditLog por escritura, sin contactos ni CUIT", async () => {
        const res = await patch("c_full", { name: "X", phone: "+54 11 5555-0177", expectedUpdatedAt: V0 });
        expect(res.status).toBe(200);
        expect(rec.audits).toHaveLength(1);
        expect(rec.audits[0].metadata).toEqual({ changedFields: "name,phone", condition: "Responsable Inscripto", iibbRegistration: "CONVENIO_MULTILATERAL" });
        expect(JSON.stringify(rec.audits[0])).not.toMatch(/5555|estudio\.test|\d{2}-\d{8}-\d/);
    });

    it("sin cambios efectivos con la versión vigente: 200 sin escritura, sin AuditLog y SIN avanzar la versión", async () => {
        const res = await patch("c_full", { name: client("c_full").name, iibb: profileV0(), expectedUpdatedAt: V0 });
        expect(res.status).toBe(200);
        expect((await res.json()).updatedAt).toBe(V0);
        expect(db.client.update).not.toHaveBeenCalled();
        expect(rec.audits).toHaveLength(0);
    });

    it("un cambio SÓLO de la ficha IIBB avanza la versión del cliente", async () => {
        const res = await patch("c_full", { iibb: { ...profileV0(), jurisdictions: [...profileV0().jurisdictions, { code: "904" }] }, expectedUpdatedAt: V0 });
        expect(res.status).toBe(200);
        const dto = await res.json();
        expect(Date.parse(dto.updatedAt)).toBeGreaterThan(Date.parse(V0));
        expect(dto.updatedAt).toBe(versionOf("c_full"));
        expect(rec.audits[0].metadata.changedFields).toBe("iibbProfile");
    });

    it("monotónica aunque el reloj esté atrasado respecto de la versión guardada (+1 ms)", async () => {
        const future = new Date("2099-01-01T00:00:00.000Z");
        client("c_full").updatedAt = future;
        const r1 = await patch("c_full", { name: "Uno", expectedUpdatedAt: future.toISOString() });
        expect((await r1.json()).updatedAt).toBe("2099-01-01T00:00:00.001Z");
        const r2 = await patch("c_full", { name: "Dos", expectedUpdatedAt: "2099-01-01T00:00:00.001Z" });
        expect((await r2.json()).updatedAt).toBe("2099-01-01T00:00:00.002Z");
    });

    it("con el reloj adelantado usa la hora actual (siempre posterior)", async () => {
        const res = await patch("c_full", { name: "X", expectedUpdatedAt: V0 });
        const v = Date.parse((await res.json()).updatedAt);
        expect(v).toBeGreaterThan(Date.parse(V0));
        expect(v).toBeLessThanOrEqual(Date.now());
    });
});

describe("clientes históricos y campos ausentes", () => {
    it("editar sólo el nombre de un histórico: contactos, inscripción y alícuota del cálculo intactos", async () => {
        const res = await patch("c_hist", { name: "Histórico SA", expectedUpdatedAt: V0 });
        expect(res.status).toBe(200);
        const c = client("c_hist");
        expect(c).toMatchObject({ name: "Histórico SA", phone: null, contactEmail: null, iibbRegistration: null, address: "Calle 1" });
        expect(c.defaultIibbRate.toString()).toBe("3");
        expect(rec.audits[0].metadata.changedFields).toBe("name");
    });

    it("campos ausentes de un cliente completo no cambian (contactos, ficha, defaultIibbRate)", async () => {
        const before = { phone: client("c_full").phone, email: client("c_full").contactEmail, rate: client("c_full").defaultIibbRate.toString() };
        const profile = snapshot("c_full");
        const res = await patch("c_full", { address: "Nueva 123", expectedUpdatedAt: V0 });
        expect(res.status).toBe(200);
        expect({ phone: client("c_full").phone, email: client("c_full").contactEmail, rate: client("c_full").defaultIibbRate.toString() }).toEqual(before);
        expect(JSON.parse(snapshot("c_full")).j).toEqual(JSON.parse(profile).j);
        expect(JSON.parse(snapshot("c_full")).r).toEqual(JSON.parse(profile).r);
        expect(db.clientJurisdiction.deleteMany).not.toHaveBeenCalled();
    });

    it("histórico con contactos vacíos en el formulario: no es un cambio, y la versión se respeta", async () => {
        const res = await patch("c_hist", { name: "Histórico SA", phone: "", contactEmail: "", expectedUpdatedAt: V0 });
        expect(res.status).toBe(200);
        expect(rec.audits[0].metadata.changedFields).toBe("name");
    });
});
