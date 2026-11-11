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

vi.mock("next/server", async (original) => ({
    ...await original<typeof import("next/server")>(),
    after: vi.fn(),
}));

import { POST as SYNC_CALLBACK } from "@/app/api/internal/arca-sync/route";
import { POST as PREVIEW } from "@/app/api/periods/[id]/libro-iva-import/preview/route";
import { POST as CONFIRM } from "@/app/api/periods/[id]/libro-iva-import/confirm/route";
import { POST as TAX_IMPORT } from "@/app/api/periods/[id]/tax-import/route";
import { POST as TAX_CREATE } from "@/app/api/taxes/route";
import { cuit } from "../helpers/libro-iva-synth";

/**
 * Descargas de ARCA por las rutas reales contra PostgreSQL LOCAL, con datos
 * SINTÉTICOS que reproducen la FORMA observada: Mis Comprobantes (CSV UTF-8,
 * NC positivas, receptor = cliente) y percepciones de IVA (8 campos, sin
 * encabezado, punto decimal).
 */
const raw = process.env.PR17_LOCAL_PG_URL;
if (raw) {
    const u = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(u.hostname) || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw Error("sólo PostgreSQL local");
}
const ORG = "org_dl_a", ORG_B = "org_dl_b";
const OWNER = "33f33f33-0000-4000-8000-0000000000a1", VIEWER = "33f33f33-0000-4000-8000-0000000000a2", OTHER = "33f33f33-0000-4000-8000-0000000000b1";
const CLIENT_CUIT = cuit("2070000003"), SELLER = cuit("3071111111"), AGENT = cuit("3070000000");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const H_RECIBIDOS = '"Fecha de Emisión";"Tipo de Comprobante";"Punto de Venta";"Número Desde";"Número Hasta";"Cód. Autorización";"Tipo Doc. Emisor";"Nro. Doc. Emisor";"Denominación Emisor";"Tipo Doc. Receptor";"Nro. Doc. Receptor";"Tipo Cambio";"Moneda";"Imp. Neto Gravado IVA 0%";"IVA 2,5%";"Imp. Neto Gravado IVA 2,5%";"IVA 5%";"Imp. Neto Gravado IVA 5%";"IVA 10,5%";"Imp. Neto Gravado IVA 10,5%";"IVA 21%";"Imp. Neto Gravado IVA 21%";"IVA 27%";"Imp. Neto Gravado IVA 27%";"Imp. Neto Gravado Total";"Imp. Neto No Gravado";"Imp. Op. Exentas";"Otros Tributos";"Total IVA";"Imp. Total"';
const recibido = (nro: number, code = 1) => ["2027-10-03", code, 7, nro, nro, "71234567890123", 80, SELLER, "PROVEEDOR SINTETICO SRL", 80, CLIENT_CUIT, "1,00", "$", "", "", "", "", "", "", "", "210,00", "1000,00", "", "", "1000,00", "0,00", "0,00", "0,00", "210,00", "1210,00"].join(";");

async function json(res: Response) { return (await res.json().catch(() => null)) as Record<string, unknown> & { error?: { code?: string }; counts?: Record<string, number>; token?: string; imported?: number }; }

describe.skipIf(!raw)("descargas de ARCA por las rutas (PostgreSQL)", () => {
    let db: PrismaClient;
    let period: string;

    beforeAll(async () => {
        db = new PrismaClient({ datasources: { db: { url: raw! } } });
        H.db.current = db;
        await db.organization.createMany({ data: [{ id: ORG, name: "Estudio sintético DL" }, { id: ORG_B, name: "Estudio sintético DL B" }], skipDuplicates: true });
        for (const [id, org, role] of [[OWNER, ORG, "OWNER"], [VIEWER, ORG, "VIEWER"], [OTHER, ORG_B, "OWNER"]] as const) {
            await db.profile.upsert({ where: { id }, create: { id, email: `${id}@example.invalid` }, update: {} });
            await db.membership.upsert({ where: { profileId_organizationId: { profileId: id, organizationId: org } }, create: { profileId: id, organizationId: org, role }, update: { role } });
        }
        await db.client.create({ data: { id: "c_dl", organizationId: ORG, name: "CLIENTE SINTETICO DL", cuit: `${CLIENT_CUIT.slice(0, 2)}-${CLIENT_CUIT.slice(2, 10)}-${CLIENT_CUIT[10]}`, condition: "Responsable Inscripto" } });
        period = (await db.period.create({ data: { clientId: "c_dl", organizationId: ORG, month: 10, year: 2027 } })).id;
    });
    afterAll(async () => { await db?.$disconnect(); });

    it("Mis Comprobantes (recibidos) por la importación: 063 sin intermediario se importa; tipos no admitidos (064) para revisar; segunda carga, ya cargados", async () => {
        H.sub = OWNER;
        const body = { clientId: "c_dl", category: "PURCHASES", format: "MIS_COMPROBANTES", vouchersFile: b64([H_RECIBIDOS, recibido(31), recibido(8, 63), recibido(9, 64)].join("\n") + "\n") };
        const req = () => new Request(`http://localhost/api/periods/${period}/libro-iva-import/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const pv = await json(await PREVIEW(req(), ctx(period)));
        expect((pv.reconciliation as { statusCounts: Record<string, number> }).statusCounts).toEqual({ OK: 2, DUPLICATE: 0, REVIEW: 1, ERROR: 0 });
        const c = await CONFIRM(new Request(`http://localhost/x`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, token: pv.token, acceptPartial: true, operationId: randomUUID() }) }), ctx(period));
        expect(c.status).toBe(201);
        const inv = await db.invoice.findMany({ where: { periodId: period }, orderBy: { voucherCode: "asc" }, select: { voucherCode: true, totalVatAmount: true, directComputableVatCreditAmount: true, source: true } });
        expect(inv.map((i) => [i.voucherCode, i.totalVatAmount?.toFixed(2), i.directComputableVatCreditAmount?.toFixed(2), i.source])).toEqual([[1, "210.00", "210.00", "IMPORT"], [63, "210.00", "210.00", "IMPORT"]]);
        const again = await json(await PREVIEW(req(), ctx(period)));
        expect((again.reconciliation as { statusCounts: Record<string, number> }).statusCounts.DUPLICATE).toBe(2);
        const audit = await db.auditLog.findFirst({ where: { action: "invoice.import", targetId: period } });
        expect((audit?.metadata as Record<string, unknown>).format).toBe("MIS_COMPROBANTES");
    });

    it("percepciones: roles y organización; vista previa; confirmación con token; segunda carga omitida; token viejo 409", async () => {
        const file = b64([`493;0;${AGENT};;2027-10-15;1;0007000000012345;1234.56`, `493;0;${AGENT};;2027-09-30;1;0007000000000002;5.00`].join("\n") + "\n");
        const call = (sub: string, body: Record<string, unknown>) => { H.sub = sub; return TAX_IMPORT(new Request(`http://localhost/api/periods/${period}/tax-import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "PERCEPTIONS", ...body }) }), ctx(period)); };
        expect((await call(VIEWER, { file })).status).toBe(403);
        expect((await call(OTHER, { file })).status).toBe(404);
        const pv = await json(await call(OWNER, { file }));
        expect(pv.counts).toEqual({ OK: 1, DUPLICATE: 0, REVIEW: 1, ERROR: 0 });
        expect((await call(OWNER, { file, confirm: true, token: "0".repeat(64) })).status).toBe(409);
        const ok = await call(OWNER, { file, confirm: true, token: pv.token });
        expect(ok.status).toBe(201);
        expect((await json(ok)).imported).toBe(1);
        const rec = await db.taxRecord.findMany({ where: { periodId: period }, select: { type: true, nature: true, regimeCode: true, agentCuit: true, voucherTypeCode: true, voucherNumber: true, amount: true } });
        expect(rec.map((r) => [r.type, r.nature, r.regimeCode, r.agentCuit, r.voucherTypeCode, r.voucherNumber, r.amount.toFixed(2)])).toEqual([["PERCEPCION IVA", "PERCEPTION", 493, AGENT, 1, "0007000000012345", "1234.56"]]);
        // Reimportar el mismo archivo: la vista previa la marca como ya registrada y no escribe nada.
        const pv2 = await json(await call(OWNER, { file }));
        expect(pv2.counts).toEqual({ OK: 0, DUPLICATE: 1, REVIEW: 1, ERROR: 0 });
        expect((await call(OWNER, { file, confirm: true, token: pv.token })).status).toBe(409);
        expect(await db.taxRecord.count({ where: { periodId: period } })).toBe(1);
        const audit = await db.auditLog.findFirst({ where: { action: "taxrecord.import", targetId: period } });
        expect(audit?.metadata).toMatchObject({ periodId: period, kind: "PERCEPTIONS", layout: "PERCEPTIONS_DOWNLOAD", importedCount: 1, duplicateCount: 0, reviewCount: 1, errorCount: 0 });
        expect(JSON.stringify(audit?.metadata)).not.toMatch(/1234|30700000|0007000000012345/);
    });

    it("retenciones: forma de diseño y luego la descarga con las mismas retenciones -> ya registradas; importes enteros sólo con confirmación", async () => {
        const AG = cuit("3066666666");
        const d9 = ["767;499;" + AG + ";;2027-10-14;6;000000000638;2027000001;3101.70", "767;499;" + AG + ";;2027-10-30;5;0000000030102027;2027000002;354480"];
        const d10 = d9.map((l) => { const f = l.split(";"); f.splice(2, 0, "0"); return f.join(";"); });
        const call = (body: Record<string, unknown>) => { H.sub = OWNER; return TAX_IMPORT(new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "RETENTIONS", ...body }) }), ctx(period)); };
        const fileA = b64(d9.join("\r\n") + "\r\n");
        const p1 = await json(await call({ file: fileA }));
        expect([p1.layout, p1.counts]).toEqual(["F2051_DESIGN", { OK: 1, DUPLICATE: 0, REVIEW: 1, ERROR: 0 }]);
        expect(p1.excludedTotal).toBe("354480.00");
        const c1 = await call({ file: fileA, confirm: true, token: p1.token });
        expect(c1.status).toBe(201);
        // Con la confirmación de pesos enteros, la segunda se importa; la primera ya está registrada.
        const p2 = await json(await call({ file: fileA, integerAmountsArePesos: true }));
        expect(p2.counts).toEqual({ OK: 1, DUPLICATE: 1, REVIEW: 0, ERROR: 0 });
        expect((await call({ file: fileA, integerAmountsArePesos: true, confirm: true, token: p2.token })).status).toBe(201);
        // La descarga de ARCA con las MISMAS retenciones: todas ya registradas, nada se escribe.
        const fileB = b64(d10.join("\n") + "\n");
        const p3 = await json(await call({ file: fileB, integerAmountsArePesos: true }));
        expect([p3.layout, p3.counts]).toEqual(["ARCA_DOWNLOAD", { OK: 0, DUPLICATE: 2, REVIEW: 0, ERROR: 0 }]);
        const rec = await db.taxRecord.findMany({ where: { periodId: period, nature: "RETENTION" }, orderBy: { certificateNumber: "asc" }, select: { type: true, taxCode: true, regimeCode: true, certificateNumber: true, amount: true } });
        expect(rec.map((r) => [r.type, r.taxCode, r.regimeCode, r.certificateNumber, r.amount.toFixed(2)])).toEqual([["RETENCION IVA", 767, 499, "2027000001", "3101.70"], ["RETENCION IVA", 767, 499, "2027000002", "354480.00"]]);
    });

    it("concurrencia: el MISMO certificado importado a la vez en dos períodos del cliente se registra una sola vez", async () => {
        const AG = cuit("3055555555");
        const nov = (await db.period.create({ data: { clientId: "c_dl", organizationId: ORG, month: 11, year: 2027 } })).id;
        const dic = (await db.period.create({ data: { clientId: "c_dl", organizationId: ORG, month: 12, year: 2027 } })).id;
        // Mismo agente y certificado; cada archivo con fecha dentro de su período.
        const fileFor = (date: string) => b64(`767;499;${AG};;${date};6;000000000777;2027009999;150.00\n`);
        const call = (periodId: string, body: Record<string, unknown>) => {
            H.sub = OWNER;
            return TAX_IMPORT(new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "RETENTIONS", ...body }) }), ctx(periodId));
        };
        for (let round = 0; round < 3; round++) {
            await db.taxRecord.deleteMany({ where: { periodId: { in: [nov, dic] } } });
            const [fa, fb] = [fileFor("2027-11-10"), fileFor("2027-12-10")];
            // Las dos vistas previas antes de confirmar: ninguna ve a la otra.
            const [pa, pb] = [await json(await call(nov, { file: fa })), await json(await call(dic, { file: fb }))];
            expect([pa.counts?.OK, pb.counts?.OK]).toEqual([1, 1]);
            const results = await Promise.all([call(nov, { file: fa, confirm: true, token: pa.token }), call(dic, { file: fb, confirm: true, token: pb.token })]);
            expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
            const rows = await db.taxRecord.findMany({ where: { periodId: { in: [nov, dic] }, certificateNumber: "2027009999" } });
            expect(rows).toHaveLength(1);
            // La que perdió, al volver a previsualizar: misma identidad con otra fecha -> para revisar (no se importa).
            const loser = rows[0].periodId === nov ? { id: dic, file: fb } : { id: nov, file: fa };
            const again = await json(await call(loser.id, { file: loser.file }));
            expect(again.counts).toEqual({ OK: 0, DUPLICATE: 0, REVIEW: 1, ERROR: 0 });
        }
        // Carga manual del mismo certificado en el otro período: 409 con el período donde ya está.
        const existing = await db.taxRecord.findFirstOrThrow({ where: { certificateNumber: "2027009999" }, include: { period: true } });
        const other = existing.periodId === nov ? { id: dic, date: "2027-12-11" } : { id: nov, date: "2027-11-11" };
        H.sub = OWNER;
        const manual = await TAX_CREATE(new Request("http://localhost/api/taxes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            periodId: other.id, date: other.date, type: "RETENCION IVA", amount: "150.00", description: "manual", nature: "RETENTION",
            taxCode: 767, regimeCode: 499, agentCuit: AG, voucherTypeCode: 6, voucherNumber: "000000000777", certificateNumber: "2027009999",
        }) }));
        expect(manual.status).toBe(409);
        expect(JSON.stringify(await json(manual))).toMatch(new RegExp(`ya está registrada para el cliente en el período ${String(existing.period.month).padStart(2, "0")}/2027`));
        // Otro agente con el MISMO número de certificado es otra retención: se admite.
        const otherAgent = await TAX_CREATE(new Request("http://localhost/api/taxes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            periodId: other.id, date: other.date, type: "RETENCION IVA", amount: "150.00", description: "manual", nature: "RETENTION",
            taxCode: 767, regimeCode: 499, agentCuit: cuit("3044444444"), voucherTypeCode: 6, voucherNumber: "000000000777", certificateNumber: "2027009999",
        }) }));
        expect(otherAgent.status).toBe(201);
    });

    it("la tarea automática autentica el envío, reutiliza el importador y conserva duplicados y pendientes", async () => {
        const target = await db.period.create({ data: { clientId: "c_dl", organizationId: ORG, month: 10, year: 2028 } });
        const lease = new Date(Date.now() + 60000);
        const task = await db.arcaSyncTask.create({ data: {
            clientId: "c_dl", periodId: target.id, organizationId: ORG, actorProfileId: OWNER, runKey: "smoke-sync",
            source: "PURCHASES", status: "RUNNING", leaseUntil: lease,
        } });
        const token = "t".repeat(48);
        vi.stubEnv("ARCA_SYNC_CONNECTOR_TOKEN", token);
        try {
            H.sub = null;
            const file = b64([H_RECIBIDOS, recibido(101).replace("2027-", "2028-"), recibido(102, 64).replace("2027-", "2028-")].join("\n") + "\n");
            const callback = (auth: string, taskId = task.id) => SYNC_CALLBACK(new Request("http://localhost/api/internal/arca-sync", {
                method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
                body: JSON.stringify({ action: "import", taskId, lease: lease.toISOString(), files: [{ format: "MIS_COMPROBANTES", file }] }),
            }));
            expect((await callback("Bearer invalid")).status).toBe(401);
            expect((await callback(`Bearer ${token}`)).status).toBe(200);
            expect((await callback(`Bearer ${token}`)).status).toBe(409);
            expect(await db.arcaSyncTask.findUnique({ where: { id: task.id } })).toMatchObject({
                status: "REVIEW", downloaded: 2, imported: 1, duplicates: 0, pending: 1, leaseUntil: null,
            });
            expect(await db.invoice.count({ where: { periodId: target.id } })).toBe(1);
            const retry = await db.arcaSyncTask.create({ data: {
                clientId: "c_dl", periodId: target.id, organizationId: ORG, actorProfileId: OWNER, runKey: "smoke-retry",
                source: "PURCHASES", status: "RUNNING", leaseUntil: lease,
            } });
            expect((await callback(`Bearer ${token}`, retry.id)).status).toBe(200);
            expect(await db.arcaSyncTask.findUnique({ where: { id: retry.id } })).toMatchObject({
                imported: 0, duplicates: 1, pending: 1,
            });
            expect(await db.invoice.count({ where: { periodId: target.id } })).toBe(1);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("período cerrado: la confirmación se rechaza sin escribir", async () => {
        await db.period.update({ where: { id: period }, data: { status: "CLOSED", closedAt: new Date() } });
        H.sub = OWNER;
        const file = b64(`493;0;${AGENT};;2027-10-16;1;0007000000099999;1.00\n`);
        const pv = await json(await TAX_IMPORT(new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "PERCEPTIONS", file }) }), ctx(period)));
        const res = await TAX_IMPORT(new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "PERCEPTIONS", file, confirm: true, token: pv.token }) }), ctx(period));
        expect(res.status).toBe(409);
        expect((await json(res)).error?.code).toBe("PERIOD_CLOSED");
        expect(await db.taxRecord.count({ where: { periodId: period } })).toBe(3);
    });
});
