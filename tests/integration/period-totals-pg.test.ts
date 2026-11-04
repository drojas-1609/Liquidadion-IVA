import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { computeLiquidation, type LiquidationResult } from "@/lib/liquidation-calc";
import { MissingGlobalProrationCoefficientError } from "@/lib/invoice-model";
import { loadPeriodLiquidationInput } from "@/lib/liquidation-totals";
import { listPeriodInvoices } from "@/lib/period-invoice-list";

/**
 * Totales del período agregados en la base y detalle paginado, contra un
 * PostgreSQL 17 LOCAL Y DESCARTABLE (scripts/pg-local-regression.sh), con datos
 * SINTÉTICOS en los volúmenes que fallaban en la Preview: 18.002 y 42.011
 * comprobantes en un período.
 *
 * Paridad: computeLiquidation sobre la entrada agregada da EXACTAMENTE lo mismo
 * que sobre la carga completa (la de antes: invoices + vatLines + taxRecords +
 * client + vatSettings), con ventas y compras, notas de crédito (restan), filas
 * heredadas, filas modeladas a medias (se liquidan como heredadas), crédito
 * directo, prorrateo global con coeficiente y retenciones.
 */
const raw = process.env.PR17_LOCAL_PG_URL ?? "";
if (raw) {
    const u = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(u.hostname) || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw Error("sólo PostgreSQL local");
}

const ORG_A = "org_tot_a", ORG_B = "org_tot_b";
const CLIENT_A = "cli_tot_a", CLIENT_B = "cli_tot_b";
const D = (v: string | number) => new Prisma.Decimal(v);
const money = (cents: number) => D((cents / 100).toFixed(2));

type InvoiceRow = Prisma.InvoiceCreateManyInput;
type LineRow = Prisma.InvoiceVatLineCreateManyInput;

/**
 * Comprobantes sintéticos deterministas. `n` filas: ~2/3 ventas, ~1/3 compras;
 * códigos 1 y 6 (suman), 3 y 8 (restan); 1 de cada 97 heredada sin modelo y 1
 * de cada 89 modelada a medias (sin neto gravado: se liquida como heredada).
 */
function synth(periodId: string, n: number, tag: string): { invoices: InvoiceRow[]; lines: LineRow[] } {
    const invoices: InvoiceRow[] = [];
    const lines: LineRow[] = [];
    const codes = [1, 1, 1, 6, 6, 3, 8];
    for (let i = 1; i <= n; i++) {
        const id = `inv_${tag}_${String(i).padStart(6, "0")}`;
        const category = i % 3 === 0 ? "PURCHASES" : "SALES";
        const code = codes[i % codes.length];
        const netC = 1_000 + ((i * 7919) % 2_500_000); // 10,00 .. 25.010,00 con centavos variados
        const vatC = Math.round(netC * 0.21);
        const extraC = (i * 31) % 5_000; // neto sin discriminar
        const base: InvoiceRow = {
            id, periodId, organizationId: ORG_A, clientId: CLIENT_A, category,
            pointOfSale: 50, number: i, date: new Date(Date.UTC(2027, 0, 1 + (i % 28))),
            netAmount: money(netC), vatAmount: money(vatC), totalAmount: money(netC + vatC + extraC),
        };
        if (i % 97 === 0) {
            invoices.push({ ...base, type: "FACTURA A" }); // heredada
            continue;
        }
        const globalC = category === "PURCHASES" && i % 4 === 0 ? Math.round(netC * 0.105) : 0;
        const modeled: InvoiceRow = {
            ...base,
            voucherCode: code, voucherDate: base.date,
            counterpartyDocType: 80, counterpartyDocNumber: category === "PURCHASES" ? `30${String(i % 50).padStart(9, "0")}` : `20${String(i % 90).padStart(9, "0")}`,
            counterpartyName: `CONTRAPARTE SINTETICA ${i % 90}`,
            taxedNetAmount: i % 89 === 0 ? null : money(netC),
            totalVatAmount: money(vatC + globalC),
            netWithoutVatBreakdownAmount: money(extraC),
            directComputableVatCreditAmount: category === "PURCHASES" ? money(vatC) : money(0),
            voucherTotalAmount: money(netC + vatC + globalC + extraC),
            grossIncomeTaxBaseAmount: category === "SALES" ? money(netC + extraC) : null,
        };
        invoices.push(modeled);
        lines.push(category === "PURCHASES"
            ? { organizationId: ORG_A, invoiceId: id, vatRateCode: 5, netAmount: money(netC), vatAmount: money(vatC), creditAllocation: "DIRECT_COMPUTABLE", computableVatAmount: money(vatC) }
            : { organizationId: ORG_A, invoiceId: id, vatRateCode: 5, netAmount: money(netC), vatAmount: money(vatC), creditAllocation: "NOT_APPLICABLE" });
        if (globalC > 0) lines.push({ organizationId: ORG_A, invoiceId: id, vatRateCode: 4, netAmount: money(Math.round(netC / 2)), vatAmount: money(globalC), creditAllocation: "GLOBAL_PRORATION" });
    }
    return { invoices, lines };
}

/** Resultado como strings de precisión completa (Decimal#toJSON): comparación exacta. */
const fmt = (r: LiquidationResult) => JSON.parse(JSON.stringify(r)) as Record<string, Record<string, string>>;

describe.skipIf(!raw)("totales del período agregados y detalle paginado, en PostgreSQL", () => {
    let db: PrismaClient;
    const P18 = "per_tot_18002", P42 = "per_tot_42011", PMISS = "per_tot_sin_coef", PB = "per_tot_org_b";

    beforeAll(async () => {
        db = new PrismaClient({ datasourceUrl: raw });
        await db.organization.createMany({ data: [{ id: ORG_A, name: "ORG SINTETICA A" }, { id: ORG_B, name: "ORG SINTETICA B" }] });
        await db.client.createMany({
            data: [
                { id: CLIENT_A, name: "CLIENTE SINTETICO TOTALES", cuit: "20700000010", condition: "RESPONSABLE_INSCRIPTO", organizationId: ORG_A, defaultIibbRate: D("3.5") },
                { id: CLIENT_B, name: "CLIENTE SINTETICO OTRA ORG", cuit: "20700000029", condition: "RESPONSABLE_INSCRIPTO", organizationId: ORG_B },
            ],
        });
        await db.period.createMany({
            data: [
                { id: P18, month: 12, year: 2026, clientId: CLIENT_A, organizationId: ORG_A },
                { id: P42, month: 1, year: 2027, clientId: CLIENT_A, organizationId: ORG_A },
                { id: PMISS, month: 2, year: 2027, clientId: CLIENT_A, organizationId: ORG_A },
                { id: PB, month: 1, year: 2027, clientId: CLIENT_B, organizationId: ORG_B },
            ],
        });
        await db.periodVatSettings.createMany({
            data: [
                { periodId: P18, organizationId: ORG_A, creditProrationMode: "GLOBAL", globalCoefficient: D("0.7312345678"), globalCoefficientStatus: "PROVISIONAL" },
                { periodId: P42, organizationId: ORG_A, creditProrationMode: "DIRECT_AND_GLOBAL", globalCoefficient: D("0.4000000001"), globalCoefficientStatus: "DEFINITIVE" },
            ],
        });
        await db.taxRecord.createMany({
            data: [
                { periodId: P42, organizationId: ORG_A, date: new Date(Date.UTC(2027, 0, 5)), type: "RETENCION IVA", amount: D("1234.56") },
                { periodId: P42, organizationId: ORG_A, date: new Date(Date.UTC(2027, 0, 6)), type: "SIRCREB", amount: D("789.01") },
            ],
        });
        for (const [periodId, n, tag, pos] of [[P18, 18_002, "a", 50], [P42, 42_011, "b", 60], [PMISS, 30, "c", 70]] as const) {
            const { invoices, lines } = synth(periodId, n, tag);
            for (let i = 0; i < invoices.length; i += 5_000) await db.invoice.createMany({ data: invoices.slice(i, i + 5_000).map((r) => ({ ...r, pointOfSale: pos })) });
            for (let i = 0; i < lines.length; i += 10_000) await db.invoiceVatLine.createMany({ data: lines.slice(i, i + 10_000) });
        }
    }, 300_000);
    afterAll(async () => {
        await db?.$disconnect();
    });

    const FULL_INCLUDE = { invoices: { include: { vatLines: true } }, taxRecords: true, client: true, vatSettings: true } as const;
    /** La carga de antes, en UNA consulta (la de las páginas del período antes de este cambio). */
    const fullLoad = (periodId: string) => db.period.findFirstOrThrow({ where: { id: periodId, organizationId: ORG_A }, include: FULL_INCLUDE });
    /**
     * Las MISMAS filas que la carga de antes, leídas en tramos de 5.000 (con
     * más de ~16.383 comprobantes la carga en una consulta no se puede hacer):
     * la referencia fila a fila para comparar los totales agregados.
     */
    async function fullLoadChunked(periodId: string) {
        const head = await db.period.findFirstOrThrow({ where: { id: periodId, organizationId: ORG_A }, include: { taxRecords: true, client: true, vatSettings: true } });
        const invoices = [];
        for (let cursor: string | undefined; ; ) {
            const page = await db.invoice.findMany({
                where: { periodId, organizationId: ORG_A }, include: { vatLines: true }, orderBy: { id: "asc" }, take: 5_000,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            });
            invoices.push(...page);
            if (page.length < 5_000) break;
            cursor = page[page.length - 1].id;
        }
        return { ...head, invoices };
    }

    it("causa del 500: la carga de antes en una consulta supera el límite de parámetros de PostgreSQL", async () => {
        // Las líneas de IVA se leen con IN (invoiceId, organizationId) por comprobante: 2 parámetros cada uno.
        await expect(fullLoad(P18)).rejects.toThrow(/too many bind variables in prepared statement, expected maximum of 32767/);
        await expect(fullLoad(P42)).rejects.toThrow(/too many bind variables/);
        await expect(fullLoad(PMISS)).resolves.toMatchObject({ id: PMISS });
    });

    it.each([
        ["18.002", P18, 18_002],
        ["42.011", P42, 42_011],
    ])("%s comprobantes: mismos totales que la carga completa, sin cargar las filas", async (_l, periodId, n) => {
        let t = Date.now();
        const full = await fullLoadChunked(periodId);
        const fullMs = Date.now() - t;
        const expected = computeLiquidation(full);
        expect(full.invoices.length).toBe(n);

        t = Date.now();
        const input = await loadPeriodLiquidationInput(db, { organizationId: ORG_A, periodId });
        const aggMs = Date.now() - t;
        expect(input).not.toBeNull();
        expect(input!.invoiceCount).toBe(n);
        expect(input!.invoices.length).toBeLessThanOrEqual(12); // grupos, no filas
        expect(fmt(computeLiquidation(input!))).toEqual(fmt(expected));
        // El caso cubre lo que importa: notas de crédito, heredadas, prorrateo y retenciones.
        expect(expected.iva.creditProrated.isZero()).toBe(false);
        expect(input!.invoices.some((r) => r.voucherCode == null)).toBe(true);
        console.info(`[period-totals] ${n} comprobantes: carga fila a fila en tramos ${fullMs} ms, agregada ${aggMs} ms, ${input!.invoices.length} grupos`);
    }, 120_000);

    it("sin coeficiente con IVA sujeto a prorrateo: el MISMO error por ambos caminos", async () => {
        const full = await fullLoad(PMISS);
        expect(() => computeLiquidation(full)).toThrow(MissingGlobalProrationCoefficientError);
        const input = await loadPeriodLiquidationInput(db, { organizationId: ORG_A, periodId: PMISS });
        expect(() => computeLiquidation(input!)).toThrow(MissingGlobalProrationCoefficientError);
    });

    it("aislamiento: otra organización no ve el período ni sus comprobantes", async () => {
        expect(await loadPeriodLiquidationInput(db, { organizationId: ORG_B, periodId: P42 })).toBeNull();
        const other = await listPeriodInvoices(db, { organizationId: ORG_B, periodId: P42 }, "SALES", 1);
        expect([other.window.total, other.invoices.length]).toEqual([0, 0]);
        const empty = await loadPeriodLiquidationInput(db, { organizationId: ORG_B, periodId: PB });
        expect(empty!.invoiceCount).toBe(0);
        const zero = computeLiquidation(empty!);
        expect([zero.sales.total.isZero(), zero.purchases.total.isZero(), zero.iva.balance.isZero()]).toEqual([true, true, true]);
    });

    it("detalle paginado de 18.002: 100 por página, orden estable, sin repetir ni saltear filas", async () => {
        const sales = await db.invoice.count({ where: { periodId: P18, organizationId: ORG_A, category: "SALES" } });
        const first = await listPeriodInvoices(db, { organizationId: ORG_A, periodId: P18 }, "SALES", 1);
        expect(first.window).toMatchObject({ page: 1, total: sales, pageCount: Math.ceil(sales / 100), from: 1, to: 100 });
        expect(first.invoices).toHaveLength(100);
        expect(first.invoices.every((i) => i.category === "SALES" && i.periodId === P18)).toBe(true);
        const seen = new Set<string>();
        for (let p = 1; p <= first.window.pageCount; p++) {
            const page = await listPeriodInvoices(db, { organizationId: ORG_A, periodId: P18 }, "SALES", p);
            for (const inv of page.invoices) seen.add(inv.id);
        }
        expect(seen.size).toBe(sales);
        const beyond = await listPeriodInvoices(db, { organizationId: ORG_A, periodId: P18 }, "SALES", 10_000);
        expect(beyond.window.page).toBe(first.window.pageCount);
        expect(beyond.invoices.length).toBe(sales - (first.window.pageCount - 1) * 100);
    }, 120_000);

    it("detalle de 42.011 compras: la última página trae el resto", async () => {
        const purchases = await db.invoice.count({ where: { periodId: P42, organizationId: ORG_A, category: "PURCHASES" } });
        const t = Date.now();
        const last = await listPeriodInvoices(db, { organizationId: ORG_A, periodId: P42 }, "PURCHASES", 999_999);
        console.info(`[period-totals] última página de ${purchases} compras en ${Date.now() - t} ms`);
        expect(last.window.to).toBe(purchases);
        expect(last.invoices.length).toBe(purchases - last.window.skip);
        expect(last.invoices.every((i) => Array.isArray(i.vatLines))).toBe(true);
    });
});
