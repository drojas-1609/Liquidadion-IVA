import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { inflateRawSync, crc32 as nodeCrc32 } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";

// Sólo se simulan las credenciales de sesión y el cliente Prisma apunta a la
// base LOCAL: autorización, bloqueos, escrituras, auditoría y exportación reales.
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
import { PATCH as CLASSIFY } from "@/app/api/periods/[id]/invoice-classification/route";
import { PUT as VAT_POSITION } from "@/app/api/periods/[id]/vat-position/route";
import { POST as CREATE_TAX } from "@/app/api/taxes/route";
import { POST as CLOSE } from "@/app/api/periods/[id]/close/route";
import { POST as REOPEN } from "@/app/api/periods/[id]/reopen/route";
import { GET as PACKAGE } from "@/app/api/periods/[id]/vat-package/route";
import { DELETE as DELETE_INVOICE } from "@/app/api/invoices/[id]/route";
import { DELETE as DELETE_PERIOD } from "@/app/api/periods/[id]/route";
import { computeLiquidation } from "@/lib/liquidation-calc";
import { loadPeriodLiquidationInput } from "@/lib/liquidation-totals";
import { contentHash, loadPeriodExportData } from "@/lib/vat-export/load";
import { parseLidFile } from "@/lib/libro-iva-import/format";
import { ansiFile, cuit, purchaseAliquotLine, purchaseVoucherLine, salesAliquotLine, salesVoucherLine } from "../helpers/libro-iva-synth";

/**
 * Circuito de presentación de IVA por sus rutas, contra PostgreSQL LOCAL y
 * descartable (scripts/pg-local-regression.sh), con datos SINTÉTICOS:
 * importación -> clasificación -> retenciones/percepciones -> posición ->
 * borrador -> cierre versionado -> descarga final reproducible -> reapertura
 * auditada -> nueva versión; aislamiento, roles, concurrencia y restricciones.
 */
const raw = process.env.PR17_LOCAL_PG_URL;
if (raw) {
    const u = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(u.hostname) || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw Error("sólo PostgreSQL local");
}
const ORG_A = "org_vx_a", ORG_B = "org_vx_b";
const OWNER = "22e22e22-0000-4000-8000-0000000000a1";
const OPERATOR = "22e22e22-0000-4000-8000-0000000000a2";
const VIEWER = "22e22e22-0000-4000-8000-0000000000a3";
const OTHER_ORG = "22e22e22-0000-4000-8000-0000000000b1";
const OPERATOR_OTHER_CLIENT = "22e22e22-0000-4000-8000-0000000000a4";
const CLIENT = "c_vx_a", CLIENT_2 = "c_vx_a2", CLIENT_B = "c_vx_b";
const BUYER = cuit("2070000003"), SELLER = cuit("3071111111"), SELLER_C = cuit("2033333333"), AGENT = cuit("3070000000");
const D = (v: string) => new Prisma.Decimal(v);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

async function json(res: Response) {
    return (await res.json().catch(() => null)) as Record<string, unknown> & { error?: { code?: string; message?: string }; field?: string };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, method: string, body?: unknown) =>
    new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function importFiles(as: string, periodId: string, clientId: string, category: "SALES" | "PURCHASES", vouchers: Uint8Array, aliquots: Uint8Array) {
    H.sub = as;
    const body = { clientId, category, vouchersFile: b64(vouchers), aliquotsFile: b64(aliquots) };
    const pv = await json(await PREVIEW(req(`/api/periods/${periodId}/libro-iva-import/preview`, "POST", body), ctx(periodId)));
    const res = await CONFIRM(req(`/api/periods/${periodId}/libro-iva-import/confirm`, "POST", { ...body, token: pv.token, operationId: randomUUID() }), ctx(periodId));
    expect(res.status).toBe(201);
}
async function classify(as: string, periodId: string, invoiceIds: string[], changes: Record<string, unknown>) {
    H.sub = as;
    const res = await CLASSIFY(req(`/api/periods/${periodId}/invoice-classification`, "PATCH", { invoiceIds, changes }), ctx(periodId));
    return { status: res.status, body: await json(res) };
}
async function close(as: string, periodId: string) {
    H.sub = as;
    const p = await H_db().period.findUniqueOrThrow({ where: { id: periodId }, select: { updatedAt: true } });
    const res = await CLOSE(req(`/api/periods/${periodId}/close`, "POST", { expectedUpdatedAt: p.updatedAt.toISOString() }), ctx(periodId));
    return { status: res.status, body: await json(res) };
}
async function reopen(as: string, periodId: string, reason?: string) {
    H.sub = as;
    const p = await H_db().period.findUniqueOrThrow({ where: { id: periodId }, select: { updatedAt: true } });
    const res = await REOPEN(req(`/api/periods/${periodId}/reopen`, "POST", { expectedUpdatedAt: p.updatedAt.toISOString(), ...(reason !== undefined ? { reason } : {}) }), ctx(periodId));
    return { status: res.status, body: await json(res) };
}
async function download(as: string, periodId: string, mode: "draft" | "final") {
    H.sub = as;
    const res = await PACKAGE(new Request(`http://localhost/api/periods/${periodId}/vat-package?mode=${mode}`), ctx(periodId));
    const bytes = res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null;
    return { status: res.status, bytes, disposition: res.headers.get("content-disposition"), body: bytes ? null : await json(res) };
}
let dbRef: PrismaClient;
const H_db = () => dbRef;

/** Lector ZIP de la prueba (independiente del escritor). */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocd = zip.length - 22;
    while (v.getUint32(eocd, true) !== 0x06054b50) eocd--;
    const n = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const out = new Map<string, Uint8Array>();
    for (let k = 0; k < n; k++) {
        const crc = v.getUint32(p + 16, true), cs = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), off = v.getUint32(p + 42, true);
        const name = Buffer.from(zip.subarray(p + 46, p + 46 + nl)).toString("latin1");
        const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
        const data = new Uint8Array(inflateRawSync(zip.subarray(start, start + cs)));
        expect(nodeCrc32(data)).toBe(crc);
        out.set(name, data);
        p += 46 + nl;
    }
    return out;
}

describe.skipIf(!raw)("presentación de IVA: clasificación, cierre versionado y paquete (PostgreSQL)", () => {
    let db: PrismaClient;
    let period: string, emptyPeriod: string, periodB: string;
    const ids = { sale: "", saleNc: "", purchase: "", purchaseC: "" };

    beforeAll(async () => {
        db = new PrismaClient({ datasources: { db: { url: raw! } } });
        dbRef = db;
        H.db.current = db;
        await db.organization.createMany({ data: [{ id: ORG_A, name: "Estudio sintético VX A" }, { id: ORG_B, name: "Estudio sintético VX B" }], skipDuplicates: true });
        await db.client.createMany({
            data: [
                { id: CLIENT, organizationId: ORG_A, name: "CLIENTE SINTETICO VX", cuit: cuit("3070000011"), condition: "Responsable Inscripto" },
                { id: CLIENT_2, organizationId: ORG_A, name: "CLIENTE SINTETICO VX 2", cuit: cuit("3070000021"), condition: "Responsable Inscripto" },
                { id: CLIENT_B, organizationId: ORG_B, name: "CLIENTE SINTETICO VX B", cuit: cuit("3070000031"), condition: "Responsable Inscripto" },
            ],
            skipDuplicates: true,
        });
        await db.clientActivity.create({ data: { organizationId: ORG_A, clientId: CLIENT, nomenclator: "ARCA", code: "620100", description: "SERVICIOS SINTETICOS" } });
        for (const [id, org, role, scope] of [
            [OWNER, ORG_A, "OWNER", "ALL"], [OPERATOR, ORG_A, "OPERATOR", "SELECTED"], [VIEWER, ORG_A, "VIEWER", "ALL"],
            [OPERATOR_OTHER_CLIENT, ORG_A, "OPERATOR", "SELECTED"], [OTHER_ORG, ORG_B, "OWNER", "ALL"],
        ] as const) {
            await db.profile.upsert({ where: { id }, create: { id, email: `${id}@example.invalid` }, update: {} });
            await db.membership.upsert({ where: { profileId_organizationId: { profileId: id, organizationId: org } }, create: { profileId: id, organizationId: org, role, clientScope: scope }, update: { role, clientScope: scope } });
        }
        const opMembership = await db.membership.findUniqueOrThrow({ where: { profileId_organizationId: { profileId: OPERATOR, organizationId: ORG_A } } });
        await db.membershipClient.create({ data: { membershipId: opMembership.id, clientId: CLIENT, organizationId: ORG_A } });
        const opOther = await db.membership.findUniqueOrThrow({ where: { profileId_organizationId: { profileId: OPERATOR_OTHER_CLIENT, organizationId: ORG_A } } });
        await db.membershipClient.create({ data: { membershipId: opOther.id, clientId: CLIENT_2, organizationId: ORG_A } });
        period = (await db.period.create({ data: { clientId: CLIENT, organizationId: ORG_A, month: 3, year: 2027 } })).id;
        emptyPeriod = (await db.period.create({ data: { clientId: CLIENT, organizationId: ORG_A, month: 4, year: 2027 } })).id;
        periodB = (await db.period.create({ data: { clientId: CLIENT_B, organizationId: ORG_B, month: 3, year: 2027 } })).id;

        // Ventas: FC A 21 % + 10,5 % y NC A; compras: FC A con percepción de IVA y FC C.
        await importFiles(OWNER, period, CLIENT, "SALES",
            ansiFile([
                salesVoucherLine({ date: "20270310", code: 1, pos: 4, number: 11, doc: BUYER, name: "CLIENTE COMPRADOR SINTETICO", total: "2315.00", aliquotCount: 2 }),
                salesVoucherLine({ date: "20270320", code: 3, pos: 4, number: 2, doc: BUYER, name: "CLIENTE COMPRADOR SINTETICO", total: "121.00", aliquotCount: 1 }),
            ]),
            ansiFile([
                salesAliquotLine({ code: 1, pos: 4, number: 11, net: "1000.00", rate: 5, vat: "210.00" }),
                salesAliquotLine({ code: 1, pos: 4, number: 11, net: "1000.00", rate: 4, vat: "105.00" }),
                salesAliquotLine({ code: 3, pos: 4, number: 2, net: "100.00", rate: 5, vat: "21.00" }),
            ]));
        await importFiles(OWNER, period, CLIENT, "PURCHASES",
            ansiFile([
                purchaseVoucherLine({ date: "20270305", code: 1, pos: 7, number: 31, doc: SELLER, name: "PROVEEDOR SINTETICO SRL", total: "1240.00", vatPerception: "30.00", aliquotCount: 1, computableCredit: "210.00" }),
                purchaseVoucherLine({ date: "20270306", code: 11, pos: 2, number: 9, doc: SELLER_C, name: "MONOTRIBUTISTA SINTETICO", total: "500.00", aliquotCount: 0, computableCredit: "0" }),
            ]),
            ansiFile([purchaseAliquotLine({ code: 1, pos: 7, number: 31, doc: SELLER, net: "1000.00", rate: 5, vat: "210.00" })]));
        const rows = await db.invoice.findMany({ where: { periodId: period }, select: { id: true, category: true, voucherCode: true } });
        ids.sale = rows.find((r) => r.category === "SALES" && r.voucherCode === 1)!.id;
        ids.saleNc = rows.find((r) => r.category === "SALES" && r.voucherCode === 3)!.id;
        ids.purchase = rows.find((r) => r.category === "PURCHASES" && r.voucherCode === 1)!.id;
        ids.purchaseC = rows.find((r) => r.category === "PURCHASES" && r.voucherCode === 11)!.id;
    });
    afterAll(async () => {
        await db?.$disconnect();
    });

    it("borrador con bloqueos: se descarga identificado como BORRADOR y omite la apertura sin clasificar", async () => {
        const d = await download(VIEWER, period, "draft");
        expect(d.status).toBe(200);
        expect(d.disposition).toContain("BORRADOR_IVA_");
        const zip = readZip(d.bytes!);
        expect(zip.has("LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt")).toBe(true);
        expect([...zip.keys()].some((k) => k.startsWith("IVA_SIMPLE_"))).toBe(false);
        expect(Buffer.from(zip.get("BORRADOR_RESUMEN.txt")!).toString("utf8")).toContain("BORRADOR — NO PRESENTAR");
        expect((await download(VIEWER, period, "final")).status).toBe(409);
    });

    it("clasificación por lote: roles, alcance, organización y reglas por categoría", async () => {
        expect((await classify(VIEWER, period, [ids.sale], { activityCode: "620100" })).status).toBe(403);
        expect((await classify(OTHER_ORG, period, [ids.sale], { activityCode: "620100" })).status).toBe(404);
        expect((await classify(OPERATOR_OTHER_CLIENT, period, [ids.sale], { activityCode: "620100" })).status).toBe(404);
        expect((await classify(OWNER, periodB, [ids.sale], { activityCode: "620100" })).status).toBe(404);
        // Comprobante de otro período del mismo cliente: 404 sin escribir.
        expect((await classify(OWNER, emptyPeriod, [ids.sale], { activityCode: "620100" })).status).toBe(404);
        const mixed = await classify(OWNER, period, [ids.sale, ids.purchase], { activityCode: "620100" });
        expect([mixed.status, mixed.body.field]).toEqual([422, "changes"]);
        const notInFicha = await classify(OWNER, period, [ids.sale], { activityCode: "999999" });
        expect([notInFicha.status, notInFicha.body.field]).toEqual([422, "activityCode"]);
        const badOpCode = await classify(OWNER, period, [ids.sale], { operationCode: "E" });
        expect([badOpCode.status, badOpCode.body.field]).toEqual([422, "operationCode"]);
        // La restricción de la base rechaza igual una clasificación cruzada escrita por fuera.
        await expect(db.invoice.update({ where: { id: ids.sale }, data: { purchaseCreditConcept: "GOODS" } })).rejects.toThrow();
        expect(await db.invoice.count({ where: { periodId: period, activityCode: { not: null } } })).toBe(0);

        const ok = await classify(OPERATOR, period, [ids.sale, ids.saleNc], { activityCode: "620100", saleOperationType: "GOODS_SERVICES", buyerType: "RESPONSABLE_INSCRIPTO" });
        expect(ok).toEqual({ status: 200, body: { periodId: period, updated: 2 } });
        expect((await classify(OPERATOR, period, [ids.purchase], { purchaseCreditConcept: "SERVICES" })).status).toBe(200);
        const audit = await db.auditLog.findFirst({ where: { organizationId: ORG_A, action: "invoice.classification_change", targetId: period }, orderBy: { createdAt: "asc" } });
        expect(audit?.metadata).toEqual({ periodId: period, category: "SALES", count: 2, changedFields: "activityCode,buyerType,saleOperationType" });
    });

    it("percepción tomada de la compra: importe exacto, una sola vez; no se puede borrar el comprobante vinculado", async () => {
        H.sub = OWNER;
        const base = { periodId: period, date: "2027-03-05", type: "PERCEPCION IVA", nature: "PERCEPTION", regimeCode: 493, agentCuit: SELLER, voucherTypeCode: 1, voucherNumber: "00007-00000031", invoiceId: ids.purchase };
        const wrong = await CREATE_TAX(req("/api/taxes", "POST", { ...base, amount: "31.00" }));
        expect([wrong.status, (await json(wrong)).field]).toEqual([422, "amount"]);
        const fromSale = await CREATE_TAX(req("/api/taxes", "POST", { ...base, amount: "30.00", invoiceId: ids.sale }));
        expect([fromSale.status, (await json(fromSale)).field]).toEqual([422, "invoiceId"]);
        expect((await CREATE_TAX(req("/api/taxes", "POST", { ...base, amount: "30.00" }))).status).toBe(201);
        expect((await CREATE_TAX(req("/api/taxes", "POST", { ...base, amount: "30.00", voucherNumber: "00007-00000099" }))).status).toBe(409);
        // Retención con certificado; el mismo certificado del mismo agente no se repite.
        const ret = { periodId: period, date: "2027-03-15", type: "RETENCION IVA", amount: "100.00", nature: "RETENTION", taxCode: 767, regimeCode: 830, agentCuit: AGENT, voucherTypeCode: 6, voucherNumber: "000000000123", certificateNumber: "0001-00000001" };
        expect((await CREATE_TAX(req("/api/taxes", "POST", ret))).status).toBe(201);
        expect((await CREATE_TAX(req("/api/taxes", "POST", { ...ret, amount: "1.00" }))).status).toBe(409);
        const inv = await db.invoice.findUniqueOrThrow({ where: { id: ids.purchase }, select: { updatedAt: true } });
        const del = await DELETE_INVOICE(new Request(`http://localhost/api/invoices/${ids.purchase}?expectedUpdatedAt=${encodeURIComponent(inv.updatedAt.toISOString())}`, { method: "DELETE" }), { params: Promise.resolve({ id: ids.purchase }) });
        // Importado: la API no lo borra (422); y la FK RESTRICT impide borrarlo por fuera mientras tenga la percepción.
        expect(del.status).toBe(422);
        await expect(db.$transaction(async (tx) => {
            await tx.invoiceVatLine.deleteMany({ where: { invoiceId: ids.purchase } });
            await tx.invoice.delete({ where: { id: ids.purchase } });
        })).rejects.toThrow();
        expect(await db.invoice.count({ where: { id: ids.purchase } })).toBe(1);
        expect(await db.invoiceVatLine.count({ where: { invoiceId: ids.purchase } })).toBe(1);
    });

    it("posición: saldo técnico y de libre disponibilidad anteriores y Anexo I; mismo motor en pantalla y paquete", async () => {
        H.sub = OWNER;
        const res = await VAT_POSITION(req(`/api/periods/${period}/vat-position`, "PUT", {
            previousTechnicalBalance: "50.00", previousTechnicalBalanceReference: "DJ sintética 02/2027",
            previousFreeBalance: "20.00", previousFreeBalanceReference: "DJ sintética 02/2027",
            adjustments: [{ regime: "LEY_27541_ANEXO_I", contributionsAmount: "1000.00", computableAmount: "73.00", reference: "F.931 sintético" }],
        }), ctx(period));
        expect(res.status).toBe(200);
        const input = await loadPeriodLiquidationInput(db, { organizationId: ORG_A, periodId: period });
        const r = computeLiquidation(input!);
        // Débito 315 − 21 = 294; crédito 210 + 73 = 283; técnico 294 − 283 − 50 = −39 (a favor).
        expect([r.iva.debit, r.iva.creditPurchases, r.iva.credit, r.iva.balance, r.iva.technicalBalanceInFavor, r.iva.previousFreeBalance, r.iva.withholdings, r.iva.perceptions, r.iva.freeBalanceInFavor].map((d) => d.toFixed(2)))
            .toEqual(["294.00", "210.00", "283.00", "-39.00", "39.00", "20.00", "100.00", "30.00", "150.00"]);
    });

    it("cierre: versión 1 con paquete final bajo el bloqueo; descarga reproducible e igual a lo guardado", async () => {
        const c = await close(OPERATOR, period);
        expect(c.status).toBe(200);
        expect(c.body).toMatchObject({ status: "CLOSED", version: 1, packageReady: true });
        const v1 = await db.periodLiquidationVersion.findFirstOrThrow({ where: { periodId: period, version: 1 } });
        expect(v1.supersededAt).toBeNull();
        expect(createHash("sha256").update(v1.packageZip!).digest("hex")).toBe(v1.packageSha256);
        const data = await loadPeriodExportData(db, { organizationId: ORG_A, periodId: period });
        expect(v1.contentHash).toBe(contentHash(data!));
        const summary = v1.summary as { liquidation: { iva: { freeBalanceInFavor: string; technicalBalanceInFavor: string } }; identity: { clientName: string } };
        expect([summary.liquidation.iva.technicalBalanceInFavor, summary.liquidation.iva.freeBalanceInFavor]).toEqual(["39.00", "150.00"]);

        const f1 = await download(VIEWER, period, "final");
        const f2 = await download(OPERATOR, period, "final");
        expect(f1.status).toBe(200);
        expect(f1.disposition).toContain("_v1.zip");
        expect(Buffer.from(f1.bytes!).equals(Buffer.from(v1.packageZip!))).toBe(true);
        expect(Buffer.from(f2.bytes!).equals(Buffer.from(f1.bytes!))).toBe(true);
        expect((await download(VIEWER, period, "draft")).status).toBe(409);
        expect((await download(OTHER_ORG, period, "final")).status).toBe(404);
        expect((await download(OPERATOR_OTHER_CLIENT, period, "final")).status).toBe(404);

        // Contenido del paquete, leído con lectores independientes del escritor.
        const zip = readZip(f1.bytes!);
        const sv = parseLidFile(zip.get("LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt")!, "SALES", "VOUCHERS");
        const pv = parseLidFile(zip.get("LIBRO_IVA_DIGITAL_COMPRAS_CBTE.txt")!, "PURCHASES", "VOUCHERS");
        expect([sv.issues, sv.records.length, pv.issues, pv.records.length]).toEqual([[], 2, [], 2]);
        expect(Buffer.from(zip.get("IVA_SIMPLE_DEBITO_FISCAL.csv")!).toString("latin1").split("\r\n").slice(1)).toEqual(["620100;1;1;4;1000,00;105,00;;", "620100;1;1;5;1000,00;210,00;;"]);
        expect(Buffer.from(zip.get("IVA_SIMPLE_RESTITUCION_DEBITO_FISCAL.csv")!).toString("latin1").split("\r\n").slice(1)).toEqual(["620100;1;1;5;100,00;21,00;"]);
        expect(Buffer.from(zip.get("IVA_SIMPLE_CREDITO_FISCAL.csv")!).toString("latin1").split("\r\n").slice(1)).toEqual(["3;5;1000,00;210,00;210,00"]);
        expect(zip.has("IVA_SIMPLE_RESTITUCION_CREDITO_FISCAL.csv")).toBe(false);
        expect(Buffer.from(zip.get("F2051_PERCEPCIONES.csv")!).toString("latin1")).toBe(`493;${SELLER};;2027-03-05;1;00007-00000031;30,00`);
        const resumen = Buffer.from(zip.get("RESUMEN.txt")!).toString("utf8");
        expect(resumen).not.toContain("[REVISAR]");
        expect(resumen).toContain("versión 1");
        const audit = await db.auditLog.findFirst({ where: { action: "vat.package.export", targetId: period }, orderBy: { createdAt: "desc" } });
        expect(audit?.metadata).toMatchObject({ mode: "FINAL", version: 1, packageSha256: v1.packageSha256 });
    });

    it("período cerrado: no admite clasificación ni retenciones; un cambio de la ficha no altera lo cerrado", async () => {
        expect((await classify(OWNER, period, [ids.purchase], { purchaseCreditConcept: "GOODS" })).body.error?.code).toBe("PERIOD_CLOSED");
        H.sub = OWNER;
        expect((await CREATE_TAX(req("/api/taxes", "POST", { periodId: period, date: "2027-03-20", type: "RETENCION IVA", amount: "5.00" }))).status).toBe(409);
        const before = await download(VIEWER, period, "final");
        await db.client.update({ where: { id: CLIENT }, data: { name: "CLIENTE SINTETICO VX (RENOMBRADO)" } });
        const after = await download(VIEWER, period, "final");
        expect(Buffer.from(after.bytes!).equals(Buffer.from(before.bytes!))).toBe(true);
        await db.client.update({ where: { id: CLIENT }, data: { name: "CLIENTE SINTETICO VX" } });
    });

    it("contenido alterado por fuera del bloqueo: la versión final no se entrega (409)", async () => {
        await db.invoice.update({ where: { id: ids.purchaseC }, data: { counterpartyName: "ALTERADO POR FUERA" } });
        const d = await download(VIEWER, period, "final");
        expect(d.status).toBe(409);
        await db.invoice.update({ where: { id: ids.purchaseC }, data: { counterpartyName: "MONOTRIBUTISTA SINTETICO" } });
        expect((await download(VIEWER, period, "final")).status).toBe(200);
    });

    it("reapertura auditada con motivo; la versión anterior queda reemplazada y un nuevo cierre es la versión 2", async () => {
        expect((await reopen(OPERATOR, period, "Corregir clasificación")).status).toBe(403);
        const noReason = await reopen(OWNER, period);
        expect([noReason.status, noReason.body.field]).toEqual([422, "reason"]);
        expect((await reopen(OWNER, period, "Corregir el concepto de una compra")).status).toBe(200);
        const v1 = await db.periodLiquidationVersion.findFirstOrThrow({ where: { periodId: period, version: 1 } });
        expect(v1.supersededAt).toBeInstanceOf(Date);
        expect([v1.supersededById, v1.reopenReason]).toEqual([OWNER, "Corregir el concepto de una compra"]);
        const audit = await db.auditLog.findFirst({ where: { action: "period.reopen", targetId: period }, orderBy: { createdAt: "desc" } });
        expect(audit?.metadata).toEqual({ clientId: CLIENT, month: 3, year: 2027, version: 1, reasonLength: "Corregir el concepto de una compra".length });
        expect((await download(VIEWER, period, "final")).status).toBe(409);

        expect((await classify(OPERATOR, period, [ids.purchase], { purchaseCreditConcept: "GOODS" })).status).toBe(200);
        const c2 = await close(OWNER, period);
        expect(c2.body).toMatchObject({ version: 2, packageReady: true });
        const [a, b] = await db.periodLiquidationVersion.findMany({ where: { periodId: period }, orderBy: { version: "asc" } });
        expect(a.contentHash).not.toBe(b.contentHash);
        expect(a.packageSha256).not.toBe(b.packageSha256);
        expect(await db.periodLiquidationVersion.count({ where: { periodId: period, supersededAt: null } })).toBe(1);
        // A lo sumo una vigente: la base lo impide aunque se intente por fuera.
        await expect(db.periodLiquidationVersion.create({ data: { organizationId: ORG_A, periodId: period, version: 3, closedAt: new Date(), engineVersion: "x", contentHash: "0".repeat(64), summary: {} } })).rejects.toThrow();
        const f = await download(VIEWER, period, "final");
        expect(f.disposition).toContain("_v2.zip");
        expect(Buffer.from(readZip(f.bytes!).get("IVA_SIMPLE_CREDITO_FISCAL.csv")!).toString("latin1").split("\r\n").slice(1)).toEqual(["1;5;1000,00;210,00;210,00"]);
    });

    it("cierre concurrente con una clasificación: nunca se intercalan; la versión refleja exactamente lo confirmado", async () => {
        expect((await reopen(OWNER, period, "Prueba de concurrencia sintética")).status).toBe(200);
        const [c, k] = await Promise.all([close(OWNER, period), classify(OPERATOR, period, [ids.purchase], { purchaseCreditConcept: "LEASES" })]);
        expect(c.status).toBe(200);
        expect([200, 409]).toContain(k.status);
        if (k.status === 409) expect(k.body.error?.code).toMatch(/PERIOD_CLOSED|PERIOD_BUSY/);
        const current = await db.periodLiquidationVersion.findFirstOrThrow({ where: { periodId: period, supersededAt: null } });
        const data = await loadPeriodExportData(db, { organizationId: ORG_A, periodId: period });
        expect(current.contentHash).toBe(contentHash(data!));
        expect((await download(VIEWER, period, "final")).status).toBe(200);
    });

    it("un período con liquidaciones cerradas no se elimina; las versiones no se escriben por la Data API", async () => {
        expect((await close(OWNER, emptyPeriod)).status).toBe(200);
        expect((await reopen(OWNER, emptyPeriod, "Prueba de borrado sintética")).status).toBe(200);
        H.sub = OWNER;
        const del = await DELETE_PERIOD(new Request(`http://localhost/api/periods/${emptyPeriod}`, { method: "DELETE" }), ctx(emptyPeriod));
        expect(del.status).toBe(409);
        expect(await db.period.count({ where: { id: emptyPeriod } })).toBe(1);
        const [rls] = await db.$queryRaw<Array<{ rls: boolean; policies: bigint }>>`
            SELECT c.relrowsecurity AS rls, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'PeriodLiquidationVersion'`;
        expect([rls.rls, Number(rls.policies)]).toEqual([true, 0]);
        const privs = await db.$queryRaw<Array<{ any: boolean }>>`
            SELECT has_table_privilege(r.oid, 'public."PeriodLiquidationVersion"', 'SELECT,INSERT,UPDATE,DELETE') AS any
            FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')`;
        expect(privs.length).toBe(3);
        expect(privs.every((p) => !p.any)).toBe(true);
    });
});

/**
 * Volumen (opcional, LID_VOLUME=1): 7.500 ventas clasificadas, cierre con
 * paquete y descarga, sin cargar el período en una única consulta.
 */
describe.skipIf(!raw || process.env.LID_VOLUME !== "1")("presentación de IVA: volumen (PostgreSQL)", () => {
    it("7.500 ventas: cierre con paquete y TXT con 7.500 registros", async () => {
        const db = new PrismaClient({ datasources: { db: { url: raw! } } });
        dbRef = db;
        H.db.current = db;
        try {
            const p = await db.period.create({ data: { clientId: CLIENT_2, organizationId: ORG_A, month: 5, year: 2027 } });
            const N = 7500;
            const inv = Array.from({ length: N }, (_, i) => ({
                id: `vxvol${String(i).padStart(20, "0")}`, periodId: p.id, organizationId: ORG_A, clientId: CLIENT_2, category: "SALES", source: "IMPORT" as const,
                type: "FC A", pointOfSale: 9, number: 100000 + i, date: new Date(Date.UTC(2027, 4, 1 + (i % 28))), voucherDate: new Date(Date.UTC(2027, 4, 1 + (i % 28))),
                voucherCode: 1, counterpartyDocType: 80, counterpartyDocNumber: BUYER, counterpartyName: "COMPRADOR SINTETICO VOLUMEN",
                currencyCode: "PES", exchangeRate: D("1"), netAmount: D("100.00"), vatAmount: D("21.00"), totalAmount: D("121.00"),
                taxedNetAmount: D("100.00"), totalVatAmount: D("21.00"), directComputableVatCreditAmount: D("0"), netWithoutVatBreakdownAmount: D("0"),
                nonTaxedAmount: D("0"), exemptAmount: D("0"), vatPerceptionAmount: D("0"), nationalPerceptionAmount: D("0"), iibbPerceptionAmount: D("0"),
                municipalPerceptionAmount: D("0"), internalTaxesAmount: D("0"), otherTaxesAmount: D("0"), grossIncomeTaxBaseAmount: D("100.00"),
                voucherTotalAmount: D("121.00"), turivaRefundAmount: D("0"), activityCode: "620100", saleOperationType: "GOODS_SERVICES" as const, buyerType: "RESPONSABLE_INSCRIPTO" as const,
            }));
            for (let i = 0; i < N; i += 1000) await db.invoice.createMany({ data: inv.slice(i, i + 1000) });
            for (let i = 0; i < N; i += 1000) {
                await db.invoiceVatLine.createMany({ data: inv.slice(i, i + 1000).map((x) => ({ organizationId: ORG_A, invoiceId: x.id, vatRateCode: 5, netAmount: D("100.00"), vatAmount: D("21.00"), creditAllocation: "NOT_APPLICABLE" as const })) });
            }
            const t0 = Date.now();
            const c = await close(OWNER, p.id);
            const ms = Date.now() - t0;
            expect(c.body).toMatchObject({ status: "CLOSED", packageReady: true });
            expect(ms).toBeLessThan(40000);
            const f = await download(VIEWER, p.id, "final");
            const sv = parseLidFile(readZip(f.bytes!).get("LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt")!, "SALES", "VOUCHERS");
            expect([sv.issues.length, sv.records.length]).toEqual([0, N]);
            console.log(`[volumen] cierre de ${N} ventas con paquete: ${ms} ms; ZIP ${f.bytes!.length} bytes`);
        } finally {
            await db.$disconnect();
        }
    }, 120000);
});
