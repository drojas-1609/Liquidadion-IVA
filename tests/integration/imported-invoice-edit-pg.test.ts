import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const H = vi.hoisted(() => ({ sub: null as string | null, db: { current: null as unknown } }));
vi.mock("@/lib/auth/claims", () => ({
    getAuthClaims: async () => (H.sub ? { sub: H.sub, email: `${H.sub}@example.invalid`, authRole: "authenticated", raw: {} } : null),
}));
vi.mock("@/lib/prisma", () => ({
    get default() {
        return H.db.current;
    },
}));

import { POST as PREVIEW } from "@/app/api/periods/[id]/libro-iva-import/preview/route";
import { POST as CONFIRM } from "@/app/api/periods/[id]/libro-iva-import/confirm/route";
import { PATCH as PATCH_DETAIL } from "@/app/api/invoices/[id]/detail/route";
import { DELETE as DELETE_INVOICE } from "@/app/api/invoices/[id]/route";
import { cuit } from "../helpers/libro-iva-synth";

/**
 * Comprobantes IMPORTADOS: corrección detallada, baja y nueva importación por
 * las rutas reales contra PostgreSQL LOCAL, con datos SINTÉTICOS (Mis
 * Comprobantes recibidos con dos alícuotas y «Otros Tributos»).
 */
const raw = process.env.PR17_LOCAL_PG_URL;
if (raw) {
    const u = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(u.hostname) || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw Error("sólo PostgreSQL local");
}
const ORG = "org_ie_a";
const OWNER = "44f44f44-0000-4000-8000-0000000000a1", ACCOUNTANT = "44f44f44-0000-4000-8000-0000000000a2", OPERATOR = "44f44f44-0000-4000-8000-0000000000a3", VIEWER = "44f44f44-0000-4000-8000-0000000000a4";
const CLIENT_CUIT = cuit("2070000011"), SELLER = cuit("3072222222");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const H_RECIBIDOS = '"Fecha de Emisión";"Tipo de Comprobante";"Punto de Venta";"Número Desde";"Número Hasta";"Cód. Autorización";"Tipo Doc. Emisor";"Nro. Doc. Emisor";"Denominación Emisor";"Tipo Doc. Receptor";"Nro. Doc. Receptor";"Tipo Cambio";"Moneda";"Imp. Neto Gravado IVA 0%";"IVA 2,5%";"Imp. Neto Gravado IVA 2,5%";"IVA 5%";"Imp. Neto Gravado IVA 5%";"IVA 10,5%";"Imp. Neto Gravado IVA 10,5%";"IVA 21%";"Imp. Neto Gravado IVA 21%";"IVA 27%";"Imp. Neto Gravado IVA 27%";"Imp. Neto Gravado Total";"Imp. Neto No Gravado";"Imp. Op. Exentas";"Otros Tributos";"Total IVA";"Imp. Total"';
// FC A 7-31: 1000 al 21 % + 1000 al 10,5 % + otros tributos 30 = 2345.
const recibido = ["2027-10-03", 1, 7, 31, 31, "71234567890123", 80, SELLER, "PROVEEDOR SINTETICO SRL", 80, CLIENT_CUIT, "1,00", "$", "", "", "", "", "", "105,00", "1000,00", "210,00", "1000,00", "", "", "2000,00", "0,00", "0,00", "30,00", "315,00", "2345,00"].join(";");
const FILE = b64([H_RECIBIDOS, recibido].join("\n") + "\n");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- respuestas JSON leídas campo a campo en las aserciones
async function json(res: Response) { return (await res.json().catch(() => null)) as Record<string, any>; }

describe.skipIf(!raw)("comprobantes importados: edición detallada, baja y nueva importación (PostgreSQL)", () => {
    let db: PrismaClient;
    let period: string;
    let invoiceId: string;

    const preview = async (extra: Record<string, unknown> = {}) => {
        H.sub = OWNER;
        return json(await PREVIEW(new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: "c_ie", category: "PURCHASES", format: "MIS_COMPROBANTES", vouchersFile: FILE, ...extra }) }), ctx(period)));
    };
    const confirm = async (token: string, extra: Record<string, unknown> = {}) => {
        H.sub = OWNER;
        return CONFIRM(new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: "c_ie", category: "PURCHASES", format: "MIS_COMPROBANTES", vouchersFile: FILE, token, acceptPartial: true, operationId: randomUUID(), ...extra }) }), ctx(period));
    };
    const current = () => db.invoice.findFirstOrThrow({ where: { id: invoiceId }, include: { vatLines: { orderBy: { vatRateCode: "asc" } } } });
    const detailBody = async (o: Record<string, unknown> = {}) => {
        const inv = await current();
        return {
            contract: "DETAILED_V1",
            expectedUpdatedAt: inv.updatedAt.toISOString(),
            voucherDate: "2027-10-03",
            counterpartyName: "PROVEEDOR SINTETICO SRL",
            counterpartyVatConditionCode: null,
            operationCode: null,
            amounts: { netWithoutVatBreakdownAmount: "0", nonTaxedAmount: "0", exemptAmount: "0", vatPerceptionAmount: "0", nationalPerceptionAmount: "0", iibbPerceptionAmount: "0", municipalPerceptionAmount: "0", internalTaxesAmount: "0", otherTaxesAmount: "30.00", turivaRefundAmount: "0" },
            reportedComputableVatCreditAmount: inv.reportedComputableVatCreditAmount?.toFixed(2) ?? null,
            vatLines: inv.vatLines.map((l) => ({ vatRateCode: l.vatRateCode, netAmount: l.netAmount.toFixed(2), vatAmount: l.vatAmount.toFixed(2), creditAllocation: l.creditAllocation, computableVatAmount: l.computableVatAmount?.toFixed(2) ?? null })),
            ...o,
        };
    };
    const patch = async (sub: string, body: unknown) => { H.sub = sub; return PATCH_DETAIL(new Request("http://localhost/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ctx(invoiceId)); };
    const del = async (sub: string) => { H.sub = sub; const inv = await db.invoice.findFirst({ where: { id: invoiceId } }); return DELETE_INVOICE(new Request(`http://localhost/x?expectedUpdatedAt=${encodeURIComponent((inv?.updatedAt ?? new Date()).toISOString())}`, { method: "DELETE" }), ctx(invoiceId)); };

    beforeAll(async () => {
        db = new PrismaClient({ datasources: { db: { url: raw! } } });
        H.db.current = db;
        await db.organization.create({ data: { id: ORG, name: "Estudio sintético IE" } });
        for (const [id, role] of [[OWNER, "OWNER"], [ACCOUNTANT, "ACCOUNTANT"], [OPERATOR, "OPERATOR"], [VIEWER, "VIEWER"]] as const) {
            await db.profile.upsert({ where: { id }, create: { id, email: `${id}@example.invalid` }, update: {} });
            await db.membership.create({ data: { profileId: id, organizationId: ORG, role } });
        }
        await db.client.create({ data: { id: "c_ie", organizationId: ORG, name: "CLIENTE SINTETICO IE", cuit: `${CLIENT_CUIT.slice(0, 2)}-${CLIENT_CUIT.slice(2, 10)}-${CLIENT_CUIT[10]}`, condition: "Responsable Inscripto" } });
        period = (await db.period.create({ data: { clientId: "c_ie", organizationId: ORG, month: 10, year: 2027 } })).id;
        const pv = await preview();
        expect(pv.reconciliation.statusCounts).toEqual({ OK: 1, DUPLICATE: 0, REVIEW: 0, ERROR: 0 });
        expect((await confirm(pv.token)).status).toBe(201);
        invoiceId = (await db.invoice.findFirstOrThrow({ where: { periodId: period } })).id;
    });
    afterAll(async () => { await db?.$disconnect(); });

    it("la importación guarda las dos alícuotas y «Otros Tributos» como otros tributos (nunca como percepción)", async () => {
        const inv = await current();
        expect(inv.source).toBe("IMPORT");
        expect(inv.vatLines.map((l) => [l.vatRateCode, l.netAmount.toFixed(2), l.vatAmount.toFixed(2)])).toEqual([[4, "1000.00", "105.00"], [5, "1000.00", "210.00"]]);
        expect([inv.otherTaxesAmount?.toFixed(2), inv.vatPerceptionAmount?.toFixed(2), inv.voucherTotalAmount?.toFixed(2)]).toEqual(["30.00", "0.00", "2345.00"]);
    });

    it("permisos: VIEWER no corrige (403); OPERATOR y ACCOUNTANT corrigen; la identidad no se puede cambiar (422)", async () => {
        expect((await patch(VIEWER, await detailBody({ counterpartyName: "X" }))).status).toBe(403);
        const bad = await patch(OPERATOR, { ...(await detailBody()), number: 99 });
        expect(bad.status).toBe(422);
        expect((await json(bad)).field).toBe("number");

        const ok = await patch(OPERATOR, await detailBody({ counterpartyName: "PROVEEDOR SINTETICO CORREGIDO SRL", amounts: { ...(await detailBody()).amounts, exemptAmount: "45.00" } }));
        expect(ok.status).toBe(200);
        const inv = await current();
        expect([inv.source, inv.counterpartyName, inv.exemptAmount?.toFixed(2), inv.voucherTotalAmount?.toFixed(2), inv.vatLines.length]).toEqual(["IMPORT", "PROVEEDOR SINTETICO CORREGIDO SRL", "45.00", "2390.00", 2]);
        expect(inv.updatedById).toBe(OPERATOR);
        const audit = await db.auditLog.findFirstOrThrow({ where: { action: "invoice.update", targetId: invoiceId }, orderBy: { createdAt: "desc" } });
        expect(audit.metadata).toMatchObject({ source: "IMPORT", changedFields: "counterpartyName,exemptAmount", numberBefore: 31, numberAfter: 31 });
        expect(JSON.stringify(audit.metadata)).not.toMatch(/PROVEEDOR|45\.00|2390|30722222222/);

        // Sin cambios: 200 sin escritura ni AuditLog nuevo.
        const before = await db.auditLog.count({ where: { targetId: invoiceId } });
        expect((await patch(ACCOUNTANT, await detailBody({ counterpartyName: "PROVEEDOR SINTETICO CORREGIDO SRL", amounts: { ...(await detailBody()).amounts, exemptAmount: "45.00" } }))).status).toBe(200);
        expect(await db.auditLog.count({ where: { targetId: invoiceId } })).toBe(before);
        // Token viejo: 409.
        const stale = await patch(ACCOUNTANT, { ...(await detailBody()), expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
        expect(stale.status).toBe(409);
    });

    it("volver a importar el corregido: «ya cargado … modificado en la app», no se sobrescribe ni se duplica", async () => {
        const pv = await preview();
        expect(pv.reconciliation.statusCounts).toEqual({ OK: 0, DUPLICATE: 1, REVIEW: 0, ERROR: 0 });
        expect(pv.rows[0].messages[0]).toMatch(/modificado en la app después de importarlo: se omite/);
        expect(await db.invoice.count({ where: { periodId: period } })).toBe(1);
        expect((await current()).counterpartyName).toBe("PROVEEDOR SINTETICO CORREGIDO SRL");
    });

    it("baja: OPERATOR y ACCOUNTANT no eliminan (403); OWNER sí, y queda el registro sin datos de la contraparte", async () => {
        expect((await del(OPERATOR)).status).toBe(403);
        expect((await del(ACCOUNTANT)).status).toBe(403);
        expect((await del(OWNER)).status).toBe(204);
        expect(await db.invoice.count({ where: { periodId: period } })).toBe(0);
        const rows = await db.invoiceImportDeletion.findMany({ where: { clientId: "c_ie" } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ category: "PURCHASES", voucherCode: 1, pointOfSale: 7, number: 31, deletedById: OWNER });
        expect(JSON.stringify(rows[0])).not.toMatch(new RegExp(SELLER));
        const audit = await db.auditLog.findFirstOrThrow({ where: { action: "invoice.delete", targetId: invoiceId } });
        expect(audit.metadata).toMatchObject({ source: "IMPORT" });
    });

    it("volver a importar el eliminado: queda para revisar; sólo con confirmación expresa se importa y libera el registro", async () => {
        const pv = await preview();
        expect(pv.reconciliation.statusCounts).toEqual({ OK: 0, DUPLICATE: 0, REVIEW: 1, ERROR: 0 });
        expect(pv.deletedCount).toBe(1);
        expect(pv.rows[0].messages.join()).toMatch(/se eliminó de la app el \d{4}-\d{2}-\d{2}/);
        // Sin filas para importar: la confirmación se rechaza (nada en silencio).
        expect((await confirm(pv.token)).status).toBe(422);
        expect(await db.invoice.count({ where: { periodId: period } })).toBe(0);

        const again = await preview({ reimportDeleted: true });
        expect(again.reconciliation.statusCounts).toEqual({ OK: 1, DUPLICATE: 0, REVIEW: 0, ERROR: 0 });
        expect(again.token).not.toBe(pv.token);
        // El token de la vista previa sin la marca no sirve para confirmar con la marca.
        expect((await confirm(pv.token, { reimportDeleted: true })).status).toBe(409);
        const c = await confirm(again.token, { reimportDeleted: true });
        expect(c.status).toBe(201);
        expect(await db.invoiceImportDeletion.count({ where: { clientId: "c_ie" } })).toBe(0);
        const back = await db.invoice.findFirstOrThrow({ where: { periodId: period } });
        // Vuelve con los datos del archivo (la corrección anterior se había eliminado).
        expect([back.counterpartyName, back.exemptAmount?.toFixed(2), back.voucherTotalAmount?.toFixed(2)]).toEqual(["PROVEEDOR SINTETICO SRL", "0.00", "2345.00"]);
        const audit = await db.auditLog.findFirstOrThrow({ where: { action: "invoice.import", targetId: period }, orderBy: { createdAt: "desc" } });
        expect(audit.metadata).toMatchObject({ reimportedDeletedCount: 1 });
        invoiceId = back.id;
    });

    it("período cerrado: ni corrección ni baja (409 PERIOD_CLOSED); exige reapertura", async () => {
        await db.period.update({ where: { id: period }, data: { status: "CLOSED", closedAt: new Date() } });
        const p = await patch(OWNER, await detailBody({ counterpartyName: "OTRO" }));
        expect([p.status, (await json(p)).error?.code]).toEqual([409, "PERIOD_CLOSED"]);
        const d = await del(OWNER);
        expect([d.status, (await json(d)).error?.code]).toEqual([409, "PERIOD_CLOSED"]);
        expect((await current()).counterpartyName).toBe("PROVEEDOR SINTETICO SRL");
    });
});
