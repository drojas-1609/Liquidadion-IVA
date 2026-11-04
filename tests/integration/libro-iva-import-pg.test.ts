import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

// Sólo se simulan las credenciales de sesión (Supabase) y el cliente Prisma
// apunta a la base LOCAL: autorización, bloqueo, escritura y auditoría son reales.
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
import { computeLiquidation } from "@/lib/liquidation-calc";
import { STALE_PREVIEW_MESSAGE, PARTIAL_IMPORT_MESSAGE } from "@/lib/libro-iva-import/service";
import { ansiFile, cuit, portalCsv, zipOne, purchaseAliquotLine, purchaseVoucherLine, salesAliquotLine, salesVoucherLine } from "../helpers/libro-iva-synth";

/**
 * Importación del Libro IVA Digital por sus rutas, contra PostgreSQL LOCAL y
 * descartable (scripts/pg-local-regression.sh), con datos SINTÉTICOS.
 */
const raw = process.env.PR17_LOCAL_PG_URL;
if (raw) {
    const u = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(u.hostname) || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw Error("sólo PostgreSQL local");
}
const ORG_A = "org_lid_a", ORG_B = "org_lid_b";
const ACCOUNTANT = "11d11d11-0000-4000-8000-0000000000c1";
const VIEWER = "11d11d11-0000-4000-8000-0000000000c2";
const OTHER_ORG = "11d11d11-0000-4000-8000-0000000000c3";
const BUYER = cuit("2070000003"), BUYER2 = cuit("2071234567"), SELLER = cuit("3071111111");
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

type Files = { category: "SALES" | "PURCHASES"; vouchers: Uint8Array; aliquots: Uint8Array; format?: "PORTAL_CSV" };
async function call(route: typeof PREVIEW, as: string, periodId: string, clientId: string, f: Files, extra: Record<string, unknown> = {}) {
    H.sub = as;
    const req = new Request(`http://localhost/api/periods/${periodId}/libro-iva-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f.format === "PORTAL_CSV"
            ? { clientId, category: f.category, format: "PORTAL_CSV", vouchersFile: b64(f.vouchers), ...extra }
            : { clientId, category: f.category, vouchersFile: b64(f.vouchers), aliquotsFile: b64(f.aliquots), ...extra }),
    });
    const res = await route(req, { params: Promise.resolve({ id: periodId }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code?: string; message?: string } } };
}

describe.skipIf(!raw)("importación Libro IVA Digital por las rutas, en PostgreSQL", () => {
    let db: PrismaClient;
    let periodA: string, periodTur: string, periodB: string;

    // Ventas: una A con dos alícuotas (21 % y 10,5 %) y una con CUIT inválido.
    const salesFiles = (): Files => ({
        category: "SALES",
        vouchers: ansiFile([
            salesVoucherLine({ date: "20261015", code: 1, pos: 3, number: 101, doc: BUYER, name: "CLIENTE SINTETICO SA", total: "2315.00", aliquotCount: 2 }),
            salesVoucherLine({ date: "20261016", code: 1, pos: 3, number: 102, doc: BUYER.slice(0, 10) + String((Number(BUYER[10]) + 1) % 10), name: "CUIT INVALIDO", total: "1210.00", aliquotCount: 1 }),
        ]),
        aliquots: ansiFile([
            salesAliquotLine({ code: 1, pos: 3, number: 101, net: "1000.00", rate: 5, vat: "210.00" }),
            salesAliquotLine({ code: 1, pos: 3, number: 101, net: "1000.00", rate: 4, vat: "105.00" }),
            salesAliquotLine({ code: 1, pos: 3, number: 102, net: "1000.00", rate: 5, vat: "210.00" }),
        ]),
    });
    const purchaseFiles = (n: number): Files => ({
        category: "PURCHASES",
        vouchers: ansiFile([purchaseVoucherLine({ date: "20261005", code: 1, pos: 7, number: n, doc: SELLER, name: "PROVEEDOR SINTETICO SRL", total: "1210.00", aliquotCount: 1, computableCredit: "210.00" })]),
        aliquots: ansiFile([purchaseAliquotLine({ code: 1, pos: 7, number: n, doc: SELLER, net: "1000.00", rate: 5, vat: "210.00" })]),
    });
    const count = (periodId: string) => db.invoice.count({ where: { periodId } });

    beforeAll(async () => {
        db = new PrismaClient({ datasources: { db: { url: raw! } } });
        H.db.current = db;
        await db.organization.createMany({ data: [{ id: ORG_A, name: "Estudio sintético LID A" }, { id: ORG_B, name: "Estudio sintético LID B" }], skipDuplicates: true });
        for (const [id, org, role] of [[ACCOUNTANT, ORG_A, "ACCOUNTANT"], [VIEWER, ORG_A, "VIEWER"], [OTHER_ORG, ORG_B, "OWNER"]] as const) {
            await db.profile.upsert({ where: { id }, create: { id, email: `${id}@example.invalid` }, update: {} });
            await db.membership.upsert({ where: { profileId_organizationId: { profileId: id, organizationId: org } }, create: { profileId: id, organizationId: org, role }, update: { role } });
        }
        await db.client.createMany({
            data: [
                { id: "c_lid_a", organizationId: ORG_A, name: "CLIENTE LID A", cuit: cuit("3070000001"), condition: "Responsable Inscripto" },
                { id: "c_lid_a2", organizationId: ORG_A, name: "CLIENTE LID A2", cuit: cuit("3070000002"), condition: "Responsable Inscripto" },
                { id: "c_lid_b", organizationId: ORG_B, name: "CLIENTE LID B", cuit: cuit("3070000004"), condition: "Responsable Inscripto" },
            ],
            skipDuplicates: true,
        });
        periodA = (await db.period.create({ data: { clientId: "c_lid_a", organizationId: ORG_A, month: 10, year: 2026 } })).id;
        periodTur = (await db.period.create({ data: { clientId: "c_lid_a2", organizationId: ORG_A, month: 10, year: 2026 } })).id;
        periodB = (await db.period.create({ data: { clientId: "c_lid_b", organizationId: ORG_B, month: 10, year: 2026 } })).id;
    });
    afterAll(async () => { await db?.$disconnect(); });

    it("organización, cliente y rol: otro cliente u otra organización 404; VIEWER 403", async () => {
        expect((await call(PREVIEW, ACCOUNTANT, periodA, "c_lid_a2", salesFiles())).status).toBe(404);
        expect((await call(PREVIEW, ACCOUNTANT, periodB, "c_lid_b", salesFiles())).status).toBe(404);
        expect((await call(PREVIEW, OTHER_ORG, periodA, "c_lid_a", salesFiles())).status).toBe(404);
        expect((await call(PREVIEW, VIEWER, periodA, "c_lid_a", salesFiles())).status).toBe(403);
        expect((await call(CONFIRM, VIEWER, periodA, "c_lid_a", salesFiles(), { token: "a".repeat(64) })).status).toBe(403);
    });

    it("fila inválida: sin aceptar parcial no escribe; aceptando, importa sólo la fila OK con sus dos alícuotas", async () => {
        const pv = await call(PREVIEW, ACCOUNTANT, periodA, "c_lid_a", salesFiles());
        expect(pv.status).toBe(200);
        expect((pv.body.rows as { status: string }[]).map((r) => r.status)).toEqual(["OK", "ERROR"]);
        const rec = pv.body.reconciliation as { byVoucherType: unknown[]; signBridge: unknown };
        expect(rec.byVoucherType).toEqual([{ voucherCode: 1, label: "FC A", sign: 1, rows: 2, importableRows: 1, informedTotal: "3525.00", signedTotal: "2315.00" }]);
        expect(rec.signBridge).toEqual({ unsignedTotal: "2315.00", creditNotesTotal: "0.00", creditNotesCount: 0, signedTotal: "2315.00" });
        const token = pv.body.token as string;
        const refused = await call(CONFIRM, ACCOUNTANT, periodA, "c_lid_a", salesFiles(), { token });
        expect([refused.status, refused.body.error?.message]).toEqual([422, PARTIAL_IMPORT_MESSAGE]);
        expect(await count(periodA)).toBe(0);

        const ok = await call(CONFIRM, ACCOUNTANT, periodA, "c_lid_a", salesFiles(), { token, acceptPartial: true });
        expect([ok.status, ok.body]).toEqual([201, { imported: 1, turiva: 0, duplicates: 0, notImported: 1 }]);
        const inv = await db.invoice.findFirstOrThrow({ where: { periodId: periodA }, include: { vatLines: { orderBy: { vatRateCode: "desc" } } } });
        expect([inv.source, inv.voucherCode, inv.number, inv.numberTo, inv.lidSection, inv.counterpartyDocNumber, inv.counterpartyVatConditionCode, inv.createdById]).toEqual(["IMPORT", 1, 101, 101, "GENERAL", BUYER, null, ACCOUNTANT]);
        expect([inv.totalVatAmount?.toFixed(2), inv.voucherTotalAmount?.toFixed(2), inv.vatRate]).toEqual(["315.00", "2315.00", null]);
        expect(inv.vatLines.map((l) => [l.vatRateCode, l.netAmount.toFixed(2), l.vatAmount.toFixed(2), l.creditAllocation, l.organizationId])).toEqual([
            [5, "1000.00", "210.00", "NOT_APPLICABLE", ORG_A],
            [4, "1000.00", "105.00", "NOT_APPLICABLE", ORG_A],
        ]);
        const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: ORG_A, action: "invoice.import", targetId: periodA } });
        expect(audit.metadata).toMatchObject({ periodId: periodA, category: "SALES", importedCount: 1, errorCount: 1, reviewCount: 0, duplicateCount: 0 });
        expect(JSON.stringify(audit.metadata)).not.toMatch(new RegExp(`${BUYER}|CLIENTE SINTETICO|2315`));

        // La liquidación vigente toma el débito del comprobante importado.
        const period = await db.period.findFirstOrThrow({ where: { id: periodA }, include: { invoices: { include: { vatLines: true } }, taxRecords: true, client: true, vatSettings: true } });
        expect(computeLiquidation(period).iva.debit.toFixed(2)).toBe("315.00");
    });

    it("segunda carga del mismo archivo: todo duplicado, nada para importar", async () => {
        const pv = await call(PREVIEW, ACCOUNTANT, periodA, "c_lid_a", salesFiles());
        expect((pv.body.rows as { status: string }[]).map((r) => r.status)).toEqual(["DUPLICATE", "ERROR"]);
        const res = await call(CONFIRM, ACCOUNTANT, periodA, "c_lid_a", salesFiles(), { token: pv.body.token, acceptPartial: true });
        expect([res.status, res.body.error?.message]).toEqual([422, "no hay comprobantes para importar"]);
        expect(await count(periodA)).toBe(1);
    });

    it("período cerrado entre la vista previa y la confirmación: 409 PERIOD_CLOSED y nada escrito", async () => {
        const files = purchaseFiles(9001);
        const pv = await call(PREVIEW, ACCOUNTANT, periodA, "c_lid_a", files);
        expect((pv.body.rows as { status: string }[]).map((r) => r.status)).toEqual(["OK"]);
        await db.period.update({ where: { id: periodA }, data: { status: "CLOSED", closedAt: new Date() } });
        try {
            const res = await call(CONFIRM, ACCOUNTANT, periodA, "c_lid_a", files, { token: pv.body.token });
            expect([res.status, res.body.error?.code]).toEqual([409, "PERIOD_CLOSED"]);
            expect(await count(periodA)).toBe(1);
        } finally {
            await db.period.update({ where: { id: periodA }, data: { status: "OPEN", closedAt: null } });
        }
        // Reabierto, la misma vista previa sigue siendo válida.
        expect((await call(CONFIRM, ACCOUNTANT, periodA, "c_lid_a", files, { token: pv.body.token })).status).toBe(201);
    });

    it("otra carga del mismo comprobante después de la vista previa, o token ajeno: 409 y nada escrito", async () => {
        const files = purchaseFiles(9002);
        const pv = await call(PREVIEW, ACCOUNTANT, periodA, "c_lid_a", files);
        await db.invoice.create({
            data: {
                pointOfSale: 7, number: 9002, netAmount: "1000", vatAmount: "210", totalAmount: "1210", category: "PURCHASES", periodId: periodA,
                organizationId: ORG_A, clientId: "c_lid_a", voucherCode: 1, counterpartyDocType: 80, counterpartyDocNumber: SELLER, source: "MANUAL",
            },
        });
        const before = await count(periodA);
        const res = await call(CONFIRM, ACCOUNTANT, periodA, "c_lid_a", files, { token: pv.body.token });
        expect([res.status, res.body.error?.message]).toEqual([409, STALE_PREVIEW_MESSAGE]);
        const other = await call(CONFIRM, ACCOUNTANT, periodA, "c_lid_a", purchaseFiles(9003), { token: pv.body.token });
        expect(other.status).toBe(409);
        expect(await count(periodA)).toBe(before);
    });

    it("TurIVA: exige la inclusión del período y conserva pestaña y reintegro", async () => {
        const files: Files = {
            category: "SALES",
            vouchers: ansiFile([salesVoucherLine({ date: "20261020", code: 195, pos: 5, number: 1, doc: BUYER2, name: "TURISTA SINTETICO", total: "1210.00", aliquotCount: 1, turivaRefund: "210.00" }, true)]),
            aliquots: ansiFile([salesAliquotLine({ code: 195, pos: 5, number: 1, net: "1000.00", rate: 5, vat: "210.00" })]),
        };
        expect(((await call(PREVIEW, ACCOUNTANT, periodTur, "c_lid_a2", files)).body.rows as { status: string }[])[0].status).toBe("ERROR");
        await db.periodVatSettings.create({ data: { periodId: periodTur, organizationId: ORG_A, turivaIncluded: true } });
        const pv = await call(PREVIEW, ACCOUNTANT, periodTur, "c_lid_a2", files);
        expect((pv.body.reconciliation as { importable: { TURIVA: { turivaRefund: string } } }).importable.TURIVA.turivaRefund).toBe("210.00");
        const res = await call(CONFIRM, ACCOUNTANT, periodTur, "c_lid_a2", files, { token: pv.body.token });
        expect([res.status, res.body]).toEqual([201, { imported: 1, turiva: 1, duplicates: 0, notImported: 0 }]);
        const inv = await db.invoice.findFirstOrThrow({ where: { periodId: periodTur } });
        expect([inv.lidSection, inv.turivaRefundAmount?.toFixed(2), inv.voucherTotalAmount?.toFixed(2)]).toEqual(["TURIVA", "210.00", "1210.00"]);
    });

    it("descarga de Portal IVA (ZIP): lo ya importado por TXT queda «ya cargado»; lo nuevo se importa con formato auditado", async () => {
        const csv = portalCsv("SALES", [
            // Mismo comprobante que la venta 3-101 importada por TXT (notas: la descarga trae las NC en negativo).
            { date: "2026-10-15", code: 1, pos: 3, number: 101, doc: BUYER, name: "CLIENTE SINTETICO SA", total: "2315.00", rates: { "21": ["1000.00", "210.00"], "10,5": ["1000.00", "105.00"] } },
            { date: "2026-10-20", code: 3, pos: 3, number: 7, doc: BUYER, name: "CLIENTE SINTETICO SA", total: "-121.00", rates: { "21": ["-100.00", "-21.00"] } },
        ]);
        const files: Files = { category: "SALES", vouchers: zipOne("comprobantes_periodo_202610_ventas_sintetico (montos expresados en pesos).csv", csv), aliquots: new Uint8Array(0), format: "PORTAL_CSV" };
        const pv = await call(PREVIEW, ACCOUNTANT, periodA, "c_lid_a", files);
        expect(pv.status).toBe(200);
        expect([pv.body.format, (pv.body.rows as { status: string }[]).map((r) => r.status)]).toEqual(["PORTAL_CSV", ["DUPLICATE", "OK"]]);
        const before = await count(periodA);
        const res = await call(CONFIRM, ACCOUNTANT, periodA, "c_lid_a", files, { token: pv.body.token });
        expect([res.status, res.body]).toEqual([201, { imported: 1, turiva: 0, duplicates: 1, notImported: 0 }]);
        expect(await count(periodA)).toBe(before + 1);
        const nc = await db.invoice.findFirstOrThrow({ where: { periodId: periodA, voucherCode: 3, number: 7 } });
        expect([nc.totalVatAmount?.toFixed(2), nc.voucherTotalAmount?.toFixed(2), nc.vatAmount.toFixed(2)]).toEqual(["21.00", "121.00", "-21.00"]);
        const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: ORG_A, action: "invoice.import", targetId: periodA }, orderBy: { createdAt: "desc" } });
        expect(audit.metadata).toMatchObject({ format: "PORTAL_CSV", importedCount: 1, duplicateCount: 1 });
        // Repetir la descarga: todo «ya cargado».
        const again = await call(PREVIEW, ACCOUNTANT, periodA, "c_lid_a", files);
        expect((again.body.rows as { status: string }[]).map((r) => r.status)).toEqual(["DUPLICATE", "DUPLICATE"]);
    });

    it("resolver pendientes: Portal IVA importa las válidas y el TXT con denominación completa sólo las dos pendientes", async () => {
        await db.client.create({ data: { id: "c_lid_a3", organizationId: ORG_A, name: "CLIENTE LID A3", cuit: cuit("3070000005"), condition: "Responsable Inscripto" } });
        const period = (await db.period.create({ data: { clientId: "c_lid_a3", organizationId: ORG_A, month: 10, year: 2026 } })).id;
        const dni = ["30111222", "30111223"];
        // Descarga de Portal IVA: 1 FC A válida y 2 FC B a consumidores con DNI sin denominación.
        const portal: Files = {
            category: "SALES", aliquots: new Uint8Array(0), format: "PORTAL_CSV",
            vouchers: zipOne("comprobantes_periodo_202610_ventas_sintetico.csv", portalCsv("SALES", [
                { date: "2026-10-02", code: 1, pos: 5, number: 35, doc: BUYER, name: "CLIENTE SINTETICO SA", total: "1210.00", rates: { "21": ["1000.00", "210.00"] } },
                { date: "2026-10-03", code: 6, pos: 5, number: 10, docType: 96, doc: dni[0], name: "", total: "121.00", rates: { "21": ["100.00", "21.00"] } },
                { date: "2026-10-04", code: 6, pos: 5, number: 11, docType: 96, doc: dni[1], name: "", total: "242.00", rates: { "21": ["200.00", "42.00"] } },
            ])),
        };
        const pv = await call(PREVIEW, ACCOUNTANT, period, "c_lid_a3", portal);
        expect((pv.body.rows as { status: string }[]).map((r) => r.status)).toEqual(["OK", "REVIEW", "REVIEW"]);
        const out = (pv.body.reconciliation as { notImported: { REVIEW: { count: number; vat: string } } }).notImported.REVIEW;
        expect(out).toMatchObject({ count: 2, vat: "63.00" });
        expect((await call(CONFIRM, ACCOUNTANT, period, "c_lid_a3", portal, { token: pv.body.token, acceptPartial: true })).body).toEqual({ imported: 1, turiva: 0, duplicates: 0, notImported: 2 });

        // TXT del mismo libro, con las denominaciones: la FC A queda «ya cargada» y entran sólo las dos FC B.
        const txt: Files = {
            category: "SALES",
            vouchers: ansiFile([
                salesVoucherLine({ date: "20261002", code: 1, pos: 5, number: 35, doc: BUYER, name: "CLIENTE SINTETICO SA", total: "1210.00", aliquotCount: 1 }),
                salesVoucherLine({ date: "20261003", code: 6, pos: 5, number: 10, docType: 96, doc: dni[0], name: "CONSUMIDOR SINTETICO UNO", total: "121.00", aliquotCount: 1 }),
                salesVoucherLine({ date: "20261004", code: 6, pos: 5, number: 11, docType: 96, doc: dni[1], name: "CONSUMIDOR SINTETICO DOS", total: "242.00", aliquotCount: 1 }),
            ]),
            aliquots: ansiFile([
                salesAliquotLine({ code: 1, pos: 5, number: 35, net: "1000.00", rate: 5, vat: "210.00" }),
                salesAliquotLine({ code: 6, pos: 5, number: 10, net: "100.00", rate: 5, vat: "21.00" }),
                salesAliquotLine({ code: 6, pos: 5, number: 11, net: "200.00", rate: 5, vat: "42.00" }),
            ]),
        };
        const pv2 = await call(PREVIEW, ACCOUNTANT, period, "c_lid_a3", txt);
        expect((pv2.body.rows as { status: string }[]).map((r) => r.status)).toEqual(["DUPLICATE", "OK", "OK"]);
        expect((await call(CONFIRM, ACCOUNTANT, period, "c_lid_a3", txt, { token: pv2.body.token })).body).toEqual({ imported: 2, turiva: 0, duplicates: 1, notImported: 0 });

        const invoices = await db.invoice.findMany({ where: { periodId: period }, orderBy: { number: "asc" }, include: { vatLines: true } });
        expect(invoices.map((i) => [i.voucherCode, i.number, i.counterpartyName])).toEqual([[6, 10, "CONSUMIDOR SINTETICO UNO"], [6, 11, "CONSUMIDOR SINTETICO DOS"], [1, 35, "CLIENTE SINTETICO SA"]]);
        const full = await db.period.findFirstOrThrow({ where: { id: period }, include: { invoices: { include: { vatLines: true } }, taxRecords: true, client: true, vatSettings: true } });
        expect(computeLiquidation(full).iva.debit.toFixed(2)).toBe("273.00");
        // Volver a subir cualquiera de los dos archivos ya no agrega nada.
        expect((((await call(PREVIEW, ACCOUNTANT, period, "c_lid_a3", portal)).body.rows) as { status: string }[]).map((r) => r.status)).toEqual(["DUPLICATE", "DUPLICATE", "DUPLICATE"]);
        expect((((await call(PREVIEW, ACCOUNTANT, period, "c_lid_a3", txt)).body.rows) as { status: string }[]).map((r) => r.status)).toEqual(["DUPLICATE", "DUPLICATE", "DUPLICATE"]);
    });
});
