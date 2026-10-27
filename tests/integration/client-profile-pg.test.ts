import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Regresión contra un PostgreSQL 17 LOCAL Y DESCARTABLE (no mocks): borrado de
 * clientes con ficha IIBB, FK en cascada alícuota -> jurisdicción, aislamiento
 * entre clientes y organizaciones, y el protocolo de la API (confirmación exacta
 * y versión) con transacciones y `FOR UPDATE` reales.
 *
 * Sólo corre con PR17_LOCAL_PG_URL apuntando a 127.0.0.1/localhost (lo arma
 * scripts/pg-local-regression.sh con un clúster temporal y las migraciones del
 * repositorio aplicadas). En la suite normal se omite. Nunca recibe ni usa
 * credenciales remotas. Datos SINTÉTICOS.
 */

const RAW_URL = process.env.PR17_LOCAL_PG_URL ?? "";
function localOnly(raw: string): string | null {
    if (!raw) return null;
    const u = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("PR17_LOCAL_PG_URL debe ser local (127.0.0.1/localhost)");
    if (/supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw new Error("PR17_LOCAL_PG_URL no puede apuntar a Supabase");
    return raw;
}
const URL_LOCAL = localOnly(RAW_URL);

const H = vi.hoisted(() => ({ db: { current: null as unknown }, claims: { value: null as unknown } }));
vi.mock("@/lib/prisma", () => ({
    get default() {
        return H.db.current;
    },
}));
vi.mock("@/lib/auth/claims", () => ({ getAuthClaims: async () => H.claims.value }));

import { DELETE, PATCH } from "@/app/api/clients/[id]/route";

const P_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const P_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const claims = (sub: string) => ({ sub, email: `${sub}@dero.test`, authRole: "authenticated", raw: {} });
const NAES_KEY = "NAES||620100";
const ARCA_KEY = "ARCA||702092";

describe.skipIf(!URL_LOCAL)("PostgreSQL local: ficha IIBB, cascadas y protocolo de edición", () => {
    let db: PrismaClient;

    beforeAll(async () => {
        db = new PrismaClient({ datasourceUrl: URL_LOCAL! });
        H.db.current = db;
        const [{ version }] = await db.$queryRaw<{ version: string }[]>`SELECT current_setting('server_version') AS version`;
        expect(version.startsWith("17.")).toBe(true);
        const [{ addr }] = await db.$queryRaw<{ addr: string | null }[]>`SELECT inet_server_addr()::text AS addr`;
        expect(addr).toBe("127.0.0.1/32");
    });
    afterAll(async () => {
        await db?.$disconnect();
    });

    /** Ficha completa: 901 (sede), 902, 921; NAES 620100 (901: 3.5, 902: sin informar); ARCA 702092 (902: 0). */
    async function seedProfile(clientId: string, organizationId: string) {
        await db.clientJurisdiction.createMany({
            data: [
                { clientId, organizationId, jurisdictionCode: "901", isHeadquarters: true },
                { clientId, organizationId, jurisdictionCode: "902" },
                { clientId, organizationId, jurisdictionCode: "921" },
            ],
        });
        const naes = await db.clientActivity.create({ data: { clientId, organizationId, nomenclator: "NAES", code: "620100", description: "Servicios sintéticos" } });
        const arca = await db.clientActivity.create({ data: { clientId, organizationId, nomenclator: "ARCA", code: "702092", description: "Otra actividad sintética" } });
        await db.clientActivityRate.createMany({
            data: [
                { clientId, organizationId, activityId: naes.id, jurisdictionCode: "901", rate: new Prisma.Decimal("3.5") },
                { clientId, organizationId, activityId: naes.id, jurisdictionCode: "902", rate: null },
                { clientId, organizationId, activityId: arca.id, jurisdictionCode: "902", rate: new Prisma.Decimal("0") },
            ],
        });
    }

    beforeEach(async () => {
        await db.$executeRawUnsafe(
            `TRUNCATE "ClientActivityRate", "ClientActivity", "ClientJurisdiction", "AuditLog", "Period", "Client", "Membership", "Profile", "Organization" CASCADE`,
        );
        await db.organization.createMany({ data: [{ id: "org_a", name: "Org A sintética" }, { id: "org_b", name: "Org B sintética" }] });
        await db.profile.createMany({ data: [{ id: P_A, email: "a@dero.test" }, { id: P_B, email: "b@dero.test" }] });
        await db.membership.createMany({
            data: [
                { profileId: P_A, organizationId: "org_a", role: "OWNER" },
                { profileId: P_B, organizationId: "org_b", role: "OWNER" },
            ],
        });
        const base = { condition: "Responsable Inscripto", phone: "+54 11 5555-0100", contactEmail: "contacto@estudio.test", iibbRegistration: "CONVENIO_MULTILATERAL" as const };
        await db.client.createMany({
            data: [
                { id: "c_a1", organizationId: "org_a", name: "Cliente A1", cuit: "30-44444444-0", ...base },
                { id: "c_a2", organizationId: "org_a", name: "Cliente A2", cuit: "30-55555555-7", ...base },
                { id: "c_b1", organizationId: "org_b", name: "Cliente B1", cuit: "30-44444444-0", ...base },
            ],
        });
        await seedProfile("c_a1", "org_a");
        await seedProfile("c_a2", "org_a");
        await seedProfile("c_b1", "org_b");
        await db.period.create({ data: { clientId: "c_a2", organizationId: "org_a", month: 1, year: 2026 } });
        H.claims.value = claims(P_A);
    });

    /** Estado persistido de un cliente (ficha completa + versión) para verificar "sin cambios". */
    async function snapshot(clientId: string) {
        const client = await db.client.findUnique({ where: { id: clientId } });
        const j = await db.clientJurisdiction.findMany({ where: { clientId }, orderBy: { jurisdictionCode: "asc" } });
        const a = await db.clientActivity.findMany({ where: { clientId }, orderBy: { code: "asc" } });
        const r = await db.clientActivityRate.findMany({ where: { clientId }, orderBy: [{ activityId: "asc" }, { jurisdictionCode: "asc" }] });
        return JSON.stringify({ client, j, a, r: r.map((x) => ({ ...x, rate: x.rate === null ? null : x.rate.toString() })) });
    }
    const counts = async (clientId: string) => ({
        j: await db.clientJurisdiction.count({ where: { clientId } }),
        a: await db.clientActivity.count({ where: { clientId } }),
        r: await db.clientActivityRate.count({ where: { clientId } }),
    });
    const del = (id: string) => DELETE(new Request(`http://localhost/api/clients/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
    const patch = (id: string, body: unknown) =>
        PATCH(
            new Request(`http://localhost/api/clients/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
            { params: Promise.resolve({ id }) },
        );
    const versionOf = async (id: string) => (await db.client.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();
    const profileV0 = () => ({
        registration: "CONVENIO_MULTILATERAL",
        jurisdictions: [{ code: "901", headquarters: true }, { code: "902" }, { code: "921" }],
        activities: [
            { nomenclator: "NAES", code: "620100", description: "Servicios sintéticos", rates: [{ jurisdiction: "901", rate: "3.5" }, { jurisdiction: "902", rate: null }] },
            { nomenclator: "ARCA", code: "702092", description: "Otra actividad sintética", rates: [{ jurisdiction: "902", rate: "0" }] },
        ],
    });
    /** Quita 902: las asociaciones guardadas que se pierden son ARCA y NAES. */
    const without902 = () => ({
        registration: "CONVENIO_MULTILATERAL",
        jurisdictions: [{ code: "901", headquarters: true }, { code: "921" }],
        activities: [
            { nomenclator: "NAES", code: "620100", description: "Servicios sintéticos", rates: [{ jurisdiction: "901", rate: "3.5" }] },
            { nomenclator: "ARCA", code: "702092", description: "Otra actividad sintética", rates: [] },
        ],
    });

    it("1. cliente con actividades, jurisdicciones y alícuotas, sin períodos: se elimina con todos sus hijos", async () => {
        expect(await counts("c_a1")).toEqual({ j: 3, a: 2, r: 3 });
        const res = await del("c_a1");
        expect(res.status).toBe(204);
        expect(await db.client.findUnique({ where: { id: "c_a1" } })).toBeNull();
        expect(await counts("c_a1")).toEqual({ j: 0, a: 0, r: 0 });
        expect(await db.auditLog.count({ where: { action: "client.delete", targetId: "c_a1" } })).toBe(1);
    });

    it("2. cliente con período: la eliminación sigue rechazada (409) y no hay borrados parciales", async () => {
        const before = await snapshot("c_a2");
        const res = await del("c_a2");
        expect(res.status).toBe(409);
        expect(await snapshot("c_a2")).toBe(before);
        expect(await db.period.count({ where: { clientId: "c_a2" } })).toBe(1);
        expect(await db.auditLog.count()).toBe(0);
        // También directo en la base: la FK RESTRICT desde Period revierte TODA la sentencia (cascadas incluidas).
        await expect(db.client.delete({ where: { id: "c_a2" } })).rejects.toMatchObject({ code: "P2003" });
        expect(await snapshot("c_a2")).toBe(before);
    });

    it("3. los datos de otro cliente y de otra organización permanecen intactos", async () => {
        const a2 = await snapshot("c_a2");
        const b1 = await snapshot("c_b1");
        expect((await del("c_a1")).status).toBe(204);
        expect(await snapshot("c_a2")).toBe(a2);
        expect(await snapshot("c_b1")).toBe(b1);
        // Otra organización no puede borrar ni ver el cliente: 404 y nada cambia.
        H.claims.value = claims(P_B);
        expect((await del("c_a2")).status).toBe(404);
        expect(await snapshot("c_a2")).toBe(a2);
    });

    it("4a. la API rechaza quitar una jurisdicción sin confirmación exacta: 422, sin escrituras ni auditoría", async () => {
        const before = await snapshot("c_a1");
        const v = await versionOf("c_a1");
        for (const confirm of [[], [{ code: "902", associations: [NAES_KEY] }], [{ code: "902", associations: [ARCA_KEY, NAES_KEY, "NAES||999999"] }]]) {
            const res = await patch("c_a1", { iibb: { ...without902(), confirmRemovedJurisdictions: confirm }, expectedUpdatedAt: v });
            expect(res.status).toBe(422);
            expect((await res.json()).field).toBe("iibb.confirmRemovedJurisdictions");
        }
        expect(await snapshot("c_a1")).toBe(before);
        expect(await db.auditLog.count()).toBe(0);
    });

    it("4b. la API rechaza una versión obsoleta: 409, sin escrituras ni auditoría", async () => {
        const before = await snapshot("c_a1");
        const res = await patch("c_a1", {
            name: "Cambio desde ficha vieja",
            iibb: { ...without902(), confirmRemovedJurisdictions: [{ code: "902", associations: [ARCA_KEY, NAES_KEY] }] },
            expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
        });
        expect(res.status).toBe(409);
        expect((await res.json()).field).toBe("expectedUpdatedAt");
        expect(await snapshot("c_a1")).toBe(before);
        expect(await db.auditLog.count()).toBe(0);
    });

    it("4c. con confirmación exacta y versión vigente se aplica; la versión avanza y hay una sola auditoría", async () => {
        const v = await versionOf("c_a1");
        const res = await patch("c_a1", {
            iibb: { ...without902(), confirmRemovedJurisdictions: [{ code: "902", associations: [ARCA_KEY, NAES_KEY] }] },
            expectedUpdatedAt: v,
        });
        expect(res.status).toBe(200);
        expect(Date.parse(await versionOf("c_a1"))).toBeGreaterThan(Date.parse(v));
        expect((await db.clientJurisdiction.findMany({ where: { clientId: "c_a1" } })).map((j) => j.jurisdictionCode).sort()).toEqual(["901", "921"]);
        expect(await counts("c_a1")).toEqual({ j: 2, a: 2, r: 1 });
        expect(await db.auditLog.count({ where: { action: "client.update", targetId: "c_a1" } })).toBe(1);
    });

    it("4d. dos PATCH simultáneos con la misma versión: FOR UPDATE real -> uno 200 y el otro 409", async () => {
        const v = await versionOf("c_a1");
        const statuses = (await Promise.all([
            patch("c_a1", { name: "Primero", expectedUpdatedAt: v }),
            patch("c_a1", { name: "Segundo", expectedUpdatedAt: v }),
        ])).map((r) => r.status).sort();
        expect(statuses).toEqual([200, 409]);
        expect(await db.auditLog.count({ where: { action: "client.update" } })).toBe(1);
    });

    it("4e. sin cambios efectivos con la versión vigente: 200 sin escritura, sin auditoría y sin avanzar la versión", async () => {
        const before = await snapshot("c_a1");
        const v = await versionOf("c_a1");
        const res = await patch("c_a1", { name: "Cliente A1", iibb: profileV0(), expectedUpdatedAt: v });
        expect(res.status).toBe(200);
        expect(await snapshot("c_a1")).toBe(before);
        expect(await db.auditLog.count()).toBe(0);
    });

    it("5. borrar DIRECTAMENTE una jurisdicción con alícuotas (fuera de la app) elimina en cascada sólo sus alícuotas", async () => {
        const otherClients = [await snapshot("c_a2"), await snapshot("c_b1")];
        await db.clientJurisdiction.delete({ where: { clientId_jurisdictionCode: { clientId: "c_a1", jurisdictionCode: "902" } } });
        const rates = await db.clientActivityRate.findMany({ where: { clientId: "c_a1" } });
        expect(rates.map((r) => r.jurisdictionCode)).toEqual(["901"]);
        // Las actividades y las demás jurisdicciones del cliente no se tocan.
        expect(await counts("c_a1")).toEqual({ j: 2, a: 2, r: 1 });
        expect([await snapshot("c_a2"), await snapshot("c_b1")]).toEqual(otherClients);
    });

    it("las FK compuestas siguen impidiendo cruzar cliente u organización", async () => {
        const naes = await db.clientActivity.findFirstOrThrow({ where: { clientId: "c_a1", code: "620100" } });
        // Alícuota de c_a1 en una jurisdicción que c_a1 no tiene (913).
        await expect(db.clientActivityRate.create({ data: { clientId: "c_a1", organizationId: "org_a", activityId: naes.id, jurisdictionCode: "913", rate: null } })).rejects.toMatchObject({ code: "P2003" });
        // Misma actividad declarada en otra organización.
        await expect(db.clientActivityRate.create({ data: { clientId: "c_a1", organizationId: "org_b", activityId: naes.id, jurisdictionCode: "921", rate: null } })).rejects.toMatchObject({ code: "P2003" });
        // Jurisdicción de c_a1 en la organización B.
        await expect(db.clientJurisdiction.create({ data: { clientId: "c_a1", organizationId: "org_b", jurisdictionCode: "913" } })).rejects.toMatchObject({ code: "P2003" });
    });
});
