import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

// Igual que libro-iva-import-pg: sólo se simulan las credenciales de sesión y
// Prisma apunta a la base LOCAL. Autorización, bloqueo y escritura son reales.
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
import { MAX_FILE_BYTES } from "@/lib/libro-iva-import/request";
import { ansiFile, cuit, nthCuit, portalCsv, zipOne, type SynthPortalRow, purchaseAliquotLine, purchaseVoucherLine, salesAliquotLine, salesVoucherLine, type SynthAliquot, type SynthVoucher } from "../helpers/libro-iva-synth";

/**
 * PRUEBA DE VOLUMEN (opcional): `LID_VOLUME=1 scripts/pg-local-regression.sh`.
 * Libros SINTÉTICOS cerca del límite de 2 MB por archivo (7.500 ventas y 6.000
 * compras, dos alícuotas cada uno), por las rutas reales y contra PostgreSQL
 * local. Mide vista previa, confirmación (transacción de 10 s) y tamaños de la
 * solicitud y la respuesta frente al máximo de 6 MB de Netlify Functions.
 */
const raw = process.env.PR17_LOCAL_PG_URL;
const enabled = Boolean(raw) && process.env.LID_VOLUME === "1";
if (raw) {
    const u = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(u.hostname) || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw Error("sólo PostgreSQL local");
}
const ORG = "org_lid_vol";
const PROFILE = "11d11d11-0000-4000-8000-0000000000d1";
const NETLIFY_MAX = 6 * 1024 * 1024;
const SALES_N = Number(process.env.LID_VOLUME_SALES ?? 7500);
const PURCHASES_N = Number(process.env.LID_VOLUME_PURCHASES ?? 6000);
const PORTAL_N = Number(process.env.LID_VOLUME_PORTAL ?? 9000);

/** Montos sintéticos coherentes: neto 21 % + neto 10,5 %, IVA exacto por línea. */
function amounts(i: number) {
    const n21 = 1000 + (i % 97) * 10, n105 = 500 + (i % 53) * 10;
    const v21 = (n21 * 21) / 100, v105 = (n105 * 105) / 1000;
    return { n21: n21.toFixed(2), v21: v21.toFixed(2), n105: n105.toFixed(2), v105: v105.toFixed(2), total: (n21 + v21 + n105 + v105).toFixed(2) };
}

const DOCS = Array.from({ length: 5000 }, (_, k) => nthCuit(2070000000, k));

function book(category: "SALES" | "PURCHASES", n: number) {
    const vouchers: string[] = [], aliquots: string[] = [];
    for (let i = 1; i <= n; i++) {
        const a = amounts(i);
        const doc = DOCS[i % DOCS.length];
        const day = String(1 + (i % 28)).padStart(2, "0");
        const v: SynthVoucher = { date: `202610${day}`, code: 1, pos: 1 + (i % 9), number: i, doc, name: `CONTRAPARTE SINTETICA ${i % 5000}`, total: a.total, aliquotCount: 2, computableCredit: (Number(a.v21) + Number(a.v105)).toFixed(2) };
        const al = (rate: number, net: string, vat: string): SynthAliquot => ({ code: 1, pos: v.pos, number: i, doc, net, rate, vat });
        if (category === "SALES") {
            vouchers.push(salesVoucherLine(v));
            aliquots.push(salesAliquotLine(al(5, a.n21, a.v21)), salesAliquotLine(al(4, a.n105, a.v105)));
        } else {
            vouchers.push(purchaseVoucherLine(v));
            aliquots.push(purchaseAliquotLine(al(5, a.n21, a.v21)), purchaseAliquotLine(al(4, a.n105, a.v105)));
        }
    }
    return { category, vouchers: ansiFile(vouchers), aliquots: ansiFile(aliquots) };
}

type Book = { category: "SALES" | "PURCHASES"; vouchers: Uint8Array; aliquots: Uint8Array; format?: "PORTAL_CSV" };

/** Descarga de Portal IVA sintética: ventas con 21 % y 10,5 % (número desde 100.000 para no chocar con el libro TXT). */
function portalBook(n: number): { csv: Uint8Array; book: Book } {
    const rows: SynthPortalRow[] = [];
    for (let i = 1; i <= n; i++) {
        const a = amounts(i);
        rows.push({ date: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`, code: 1, pos: 1 + (i % 9), number: 100000 + i, doc: DOCS[i % DOCS.length], name: `CONTRAPARTE SINTETICA ${i % 5000}`, total: a.total, rates: { "21": [a.n21, a.v21], "10,5": [a.n105, a.v105] } });
    }
    const csv = portalCsv("SALES", rows);
    return { csv, book: { category: "SALES", vouchers: zipOne("comprobantes_periodo_202610_ventas_volumen.csv", csv), aliquots: new Uint8Array(0), format: "PORTAL_CSV" } };
}
async function call(route: typeof PREVIEW, periodId: string, b: Book, extra: Record<string, unknown> = {}) {
    H.sub = PROFILE;
    const body = JSON.stringify(b.format === "PORTAL_CSV"
        ? { clientId: "c_lid_vol", category: b.category, format: "PORTAL_CSV", vouchersFile: Buffer.from(b.vouchers).toString("base64"), ...extra }
        : { clientId: "c_lid_vol", category: b.category, vouchersFile: Buffer.from(b.vouchers).toString("base64"), aliquotsFile: Buffer.from(b.aliquots).toString("base64"), ...extra });
    const t0 = performance.now();
    const res = await route(new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body }), { params: Promise.resolve({ id: periodId }) });
    const text = await res.text();
    return { status: res.status, ms: Math.round(performance.now() - t0), requestBytes: body.length, responseBytes: text.length, body: JSON.parse(text) as Record<string, unknown> & { error?: { message?: string } } };
}

describe.skipIf(!enabled)("volumen: libros sintéticos cerca del límite, por las rutas reales", () => {
    let db: PrismaClient, period: string;
    const report: string[] = [];
    beforeAll(async () => {
        db = new PrismaClient({ datasources: { db: { url: raw! } } });
        H.db.current = db;
        await db.organization.upsert({ where: { id: ORG }, create: { id: ORG, name: "Estudio sintético volumen" }, update: {} });
        await db.profile.upsert({ where: { id: PROFILE }, create: { id: PROFILE, email: "vol@example.invalid" }, update: {} });
        await db.membership.upsert({ where: { profileId_organizationId: { profileId: PROFILE, organizationId: ORG } }, create: { profileId: PROFILE, organizationId: ORG, role: "ACCOUNTANT" }, update: {} });
        await db.client.upsert({ where: { id: "c_lid_vol" }, create: { id: "c_lid_vol", organizationId: ORG, name: "CLIENTE VOLUMEN", cuit: cuit("3079999999"), condition: "Responsable Inscripto" }, update: {} });
        period = (await db.period.create({ data: { clientId: "c_lid_vol", organizationId: ORG, month: 10, year: 2026 } })).id;
    });
    afterAll(async () => {
        console.log("\n[volumen libro IVA]\n" + report.join("\n"));
        await db?.$disconnect();
    });

    for (const [category, n] of [["SALES", SALES_N], ["PURCHASES", PURCHASES_N]] as const) {
        it(`${category}: ${n} comprobantes con dos alícuotas`, async () => {
            const b = book(category, n);
            expect(b.vouchers.length).toBeLessThanOrEqual(MAX_FILE_BYTES);
            expect(b.aliquots.length).toBeLessThanOrEqual(MAX_FILE_BYTES);
            const pv = await call(PREVIEW, period, b);
            expect(pv.status).toBe(200);
            expect((pv.body.reconciliation as { statusCounts: Record<string, number> }).statusCounts).toEqual({ OK: n, DUPLICATE: 0, REVIEW: 0, ERROR: 0 });
            const cf = await call(CONFIRM, period, b, { token: pv.body.token });
            report.push(`${category}: ${n} cbtes · archivos ${(b.vouchers.length / 1048576).toFixed(2)} MB + ${(b.aliquots.length / 1048576).toFixed(2)} MB · solicitud ${(pv.requestBytes / 1048576).toFixed(2)} MB · respuesta vista previa ${(pv.responseBytes / 1048576).toFixed(2)} MB · vista previa ${pv.ms} ms · confirmación ${cf.ms} ms (${cf.status}${cf.body.error ? " " + cf.body.error.message : ""})`);
            expect(cf.status).toBe(201);
            expect(cf.body).toMatchObject({ imported: n });
            expect(await db.invoice.count({ where: { periodId: period, category } })).toBe(n);
            expect(await db.invoiceVatLine.count({ where: { invoice: { periodId: period, category } } })).toBe(2 * n);
            expect(pv.requestBytes).toBeLessThan(NETLIFY_MAX);
            expect(pv.responseBytes).toBeLessThan(NETLIFY_MAX);
            // Repetir la carga no duplica: todo queda «ya cargado».
            const again = await call(PREVIEW, period, b);
            expect((again.body.reconciliation as { statusCounts: Record<string, number> }).statusCounts).toEqual({ OK: 0, DUPLICATE: n, REVIEW: 0, ERROR: 0 });
            report.push(`${category}: segunda vista previa ${again.ms} ms, ${n} ya cargados`);
        }, 120_000);
    }

    it(`PORTAL_CSV: ${PORTAL_N} ventas en un ZIP cuyo CSV queda cerca de 2 MB`, async () => {
        const { csv, book: b } = portalBook(PORTAL_N);
        expect(csv.length).toBeLessThanOrEqual(MAX_FILE_BYTES);
        const pv = await call(PREVIEW, period, b);
        expect(pv.status).toBe(200);
        expect((pv.body.reconciliation as { statusCounts: Record<string, number> }).statusCounts).toEqual({ OK: PORTAL_N, DUPLICATE: 0, REVIEW: 0, ERROR: 0 });
        const cf = await call(CONFIRM, period, b, { token: pv.body.token });
        report.push(`PORTAL_CSV: ${PORTAL_N} cbtes · CSV ${(csv.length / 1048576).toFixed(2)} MB · ZIP ${(b.vouchers.length / 1048576).toFixed(2)} MB · solicitud ${(pv.requestBytes / 1048576).toFixed(2)} MB · respuesta vista previa ${(pv.responseBytes / 1048576).toFixed(2)} MB · vista previa ${pv.ms} ms · confirmación ${cf.ms} ms (${cf.status})`);
        expect(cf.status).toBe(201);
        expect(pv.responseBytes).toBeLessThan(NETLIFY_MAX);
        const again = await call(PREVIEW, period, b);
        expect((again.body.reconciliation as { statusCounts: Record<string, number> }).statusCounts.DUPLICATE).toBe(PORTAL_N);
        report.push(`PORTAL_CSV: segunda vista previa ${again.ms} ms, ${PORTAL_N} ya cargados`);
    }, 120_000);
});
