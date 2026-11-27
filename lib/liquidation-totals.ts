import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { InvoiceForCalc, PeriodForCalc } from "./liquidation-calc";
import { previousIibbBalance, iibbPositionWithPrevious, type PreviousIibbBalance } from "./iibb-previous-balance";
import { normalizeInvoiceRow, voucherDisplayLabel, voucherSign } from "./invoice-model";
import { allocateCost, PROVIDER_MODES, type CostInvoice, type CostProvider, type ProviderMode, type RateMap } from "./iibb/provider-costs";
import { pickYearRate, rateYearKey } from "./iibb/rate-years";
import { sum } from "./decimal";
import type { IibbSaleSlice } from "./iibb/activity-base";

/**
 * Entrada de `computeLiquidation` para el período COMPLETO sin cargar cada
 * comprobante: la base suma los importes agrupando por todo lo que el cálculo
 * usa para decidir (categoría, código de comprobante y si la fila está
 * modelada), y cada grupo entra al cálculo como una fila más.
 *
 * Es equivalente fila a fila porque `normalizeInvoiceRow` es lineal en los
 * importes (cada aporte es importe × signo del código, o el importe heredado),
 * y `computeLiquidation` sólo suma esos aportes y aplica el prorrateo global UNA
 * vez sobre el total del período (`hasGlobalProrationLines` se usa con `some`).
 * Las sumas de PostgreSQL sobre numeric son exactas. La paridad se prueba en
 * tests/integration/period-totals-pg.test.ts contra la carga completa.
 *
 * Filtra por período y organización (ya autorizados por requirePeriodAccess con
 * el cliente esperado). Sólo consultas de Prisma (groupBy / aggregate): sin SQL
 * crudo fuera del inventario de bloqueos.
 */

/**
 * Mismo criterio que `isModeled` (lib/invoice-model): si cambia uno, cambia el
 * otro (lo cubre la prueba de paridad con filas parcialmente nulas). Todas las
 * condiciones son IS NOT NULL o comparan una columna NOT NULL, así que `NOT`
 * de este filtro es exactamente el conjunto de filas heredadas.
 */
const MODELED: Prisma.InvoiceWhereInput = {
    voucherCode: { not: null },
    taxedNetAmount: { not: null },
    totalVatAmount: { not: null },
    netWithoutVatBreakdownAmount: { not: null },
    directComputableVatCreditAmount: { not: null },
    voucherTotalAmount: { not: null },
    OR: [{ category: { not: "SALES" } }, { grossIncomeTaxBaseAmount: { not: null } }],
};

export interface PeriodLiquidationScope {
    organizationId: string;
    periodId: string;
}

export interface PeriodLiquidationInput extends PeriodForCalc {
    /** Comprobantes del período (todas las categorías). */
    invoiceCount: number;
    /** Saldo a favor de IIBB del período anterior, cuando se toma automáticamente (sin datos cargados). */
    iibbPreviousBalanceAuto: PreviousIibbBalance | null;
}

const ZERO = new Prisma.Decimal(0);

/**
 * Jurisdicción de la DDJJ local de IIBB: cliente inscripto como LOCAL en una
 * sola jurisdicción. En Convenio Multilateral u otros casos: null (se computan
 * todas las deducciones, como antes).
 */
export function localIibbJurisdiction(c: { iibbRegistration: string | null; jurisdictions: { jurisdictionCode: string }[] }): string | null {
    return c.iibbRegistration === "LOCAL" && c.jurisdictions.length === 1 ? c.jurisdictions[0].jurisdictionCode : null;
}
const z = (v: Prisma.Decimal | null | undefined) => v ?? ZERO;

type Db = Pick<PrismaClient, "period" | "invoice" | "invoiceVatLine" | "clientIibbRateYear" | "clientIibbProvider" | "periodIibbCostAdjustment">;

/** Detalle por compra para la pantalla del período (reparto manual y pendientes). */
export interface ProviderCostInvoice {
    id: string;
    cuit: string;
    providerName: string;
    mode: ProviderMode;
    label: string;
    date: string | null;
    net: Prisma.Decimal;
    byActivity: Array<{ activityCode: string; amount: Prisma.Decimal }>;
    pending: boolean;
    manual: boolean;
}

/**
 * Costo de prestadores del período por actividad (base por diferencia, criterio
 * del estudio): compras a los CUIT marcados, netas de IVA, repartidas según el
 * modo de cada prestador (lib/iibb/provider-costs.ts), más el ajuste manual del
 * período. La parte asignada a "" (no resta) no entra en el costo.
 */
export async function iibbProviderCosts(
    db: Pick<PrismaClient, "invoice" | "clientIibbProvider" | "periodIibbCostAdjustment">,
    scope: { organizationId: string; periodId: string; clientId: string },
): Promise<{
    costs: Record<string, { providers: Prisma.Decimal; adjustment: Prisma.Decimal }>;
    byProvider: Array<{ cuit: string; name: string; activityCode: string; mode: ProviderMode; amount: Prisma.Decimal; count: number; pending: number }>;
    invoices: ProviderCostInvoice[];
    pendingCount: number;
}> {
    const [providerRows, adjustments] = await Promise.all([
        db.clientIibbProvider.findMany({ where: { clientId: scope.clientId, organizationId: scope.organizationId }, select: { cuit: true, name: true, activityCode: true, mode: true, rateMap: true }, orderBy: { name: "asc" } }),
        db.periodIibbCostAdjustment.findMany({ where: { periodId: scope.periodId, organizationId: scope.organizationId }, select: { activityCode: true, amount: true } }),
    ]);
    const providers: CostProvider[] = providerRows.map((p) => ({
        cuit: p.cuit, name: p.name, activityCode: p.activityCode,
        mode: (PROVIDER_MODES as readonly string[]).includes(p.mode) ? (p.mode as ProviderMode) : "SINGLE",
        rateMap: p.rateMap && typeof p.rateMap === "object" && !Array.isArray(p.rateMap) ? (p.rateMap as RateMap) : null,
    }));
    const costs: Record<string, { providers: Prisma.Decimal; adjustment: Prisma.Decimal }> = {};
    const add = (code: string, k: "providers" | "adjustment", v: Prisma.Decimal) => {
        if (code === "") return;
        const c = (costs[code] ??= { providers: ZERO, adjustment: ZERO });
        c[k] = c[k].plus(v);
    };
    const byProvider: Array<{ cuit: string; name: string; activityCode: string; mode: ProviderMode; amount: Prisma.Decimal; count: number; pending: number }> = [];
    const invoices: ProviderCostInvoice[] = [];
    if (providers.length > 0) {
        const cuits = providers.map((p) => p.cuit);
        const dashed = cuits.map((c) => `${c.slice(0, 2)}-${c.slice(2, 10)}-${c[10]}`);
        const rows = await db.invoice.findMany({
            where: {
                periodId: scope.periodId, organizationId: scope.organizationId, category: "PURCHASES",
                OR: [{ ...MODELED, counterpartyDocNumber: { in: cuits } }, { NOT: MODELED, entityCuit: { in: [...cuits, ...dashed] } }],
            },
            select: {
                id: true, voucherCode: true, pointOfSale: true, number: true, voucherDate: true, date: true, entityCuit: true, counterpartyDocNumber: true, netAmount: true,
                exemptAmount: true, nonTaxedAmount: true, netWithoutVatBreakdownAmount: true,
                taxedNetAmount: true, totalVatAmount: true, directComputableVatCreditAmount: true, voucherTotalAmount: true,
                vatLines: { select: { vatRateCode: true, netAmount: true } },
                iibbCostSplits: { select: { activityCode: true, amount: true } },
            },
            orderBy: [{ voucherDate: "asc" }, { pointOfSale: "asc" }, { number: "asc" }],
        });
        for (const p of providers) {
            let amount = ZERO;
            let count = 0;
            let pending = 0;
            for (const r of rows) {
                // Mismo criterio que MODELED (compras: sin la condición de ventas).
                const modeled = r.voucherCode !== null && r.taxedNetAmount !== null && r.totalVatAmount !== null && r.netWithoutVatBreakdownAmount !== null && r.directComputableVatCreditAmount !== null && r.voucherTotalAmount !== null;
                const cuit = modeled ? r.counterpartyDocNumber : (r.entityCuit ?? "").replace(/-/g, "");
                if (cuit !== p.cuit) continue;
                const byRate = new Map<number, Prisma.Decimal>();
                for (const l of r.vatLines) byRate.set(l.vatRateCode, (byRate.get(l.vatRateCode) ?? ZERO).plus(l.netAmount));
                const inv: CostInvoice = {
                    id: r.id,
                    sign: modeled ? voucherSign(r.voucherCode as number) : 1,
                    vatNets: [...byRate.entries()].map(([code, net]) => ({ code, net })),
                    exemptAndNonTaxed: z(r.exemptAmount).plus(z(r.nonTaxedAmount)),
                    withoutVat: z(r.netWithoutVatBreakdownAmount),
                    legacyNet: modeled ? null : r.netAmount,
                    splits: r.iibbCostSplits,
                };
                const a = allocateCost(p, inv);
                for (const [code, v] of a.byActivity) {
                    add(code, "providers", v);
                    if (code !== "") amount = amount.plus(v);
                }
                count += 1;
                if (a.pending) pending += 1;
                const d = r.voucherDate ?? r.date;
                invoices.push({
                    id: r.id, cuit: p.cuit, providerName: p.name, mode: p.mode,
                    label: `${modeled ? voucherDisplayLabel(r.voucherCode as number) : "Comprobante"} ${String(r.pointOfSale).padStart(5, "0")}-${String(r.number).padStart(8, "0")}`,
                    date: d ? d.toISOString().slice(0, 10) : null,
                    net: a.net,
                    byActivity: [...a.byActivity.entries()].map(([activityCode, v]) => ({ activityCode, amount: v })),
                    pending: a.pending, manual: a.manual,
                });
            }
            byProvider.push({ ...p, amount, count, pending });
        }
    }
    for (const a of adjustments) add(a.activityCode, "adjustment", a.amount);
    return { costs, byProvider, invoices, pendingCount: invoices.filter((i) => i.pending).length };
}

export async function loadPeriodLiquidationInput(db: Db, scope: PeriodLiquidationScope): Promise<PeriodLiquidationInput | null> {
    const period = await db.period.findFirst({
        where: { id: scope.periodId, organizationId: scope.organizationId },
        select: {
            clientId: true, month: true, year: true,
            taxRecords: { select: { type: true, amount: true, nature: true, jurisdictionCode: true } },
            client: {
                select: {
                    defaultIibbRate: true,
                    iibbRegistration: true,
                    iibbPrincipalActivityCode: true,
                    jurisdictions: { select: { jurisdictionCode: true } },
                    posActivities: { select: { pointOfSale: true, activityCode: true } },
                    activities: { select: { code: true, description: true, rates: { select: { jurisdictionCode: true, rate: true, treatment: true, minimumAmount: true, additionalLabel: true, additionalRate: true } } } },
                },
            },
            iibbPosition: { select: { previousBalance: true, paymentsOnAccount: true, otherCredits: true, otherDebits: true } },
            vatSettings: { select: { creditProrationMode: true, globalCoefficient: true, previousTechnicalBalance: true, previousFreeBalance: true } },
            vatCreditAdjustments: { select: { regime: true, computableAmount: true }, orderBy: { regime: "asc" } },
        },
    });
    if (!period) return null;
    // Sin datos de la DDJJ cargados: saldo anterior desde el período anterior registrado.
    const auto = period.iibbPosition ? null : await previousIibbBalance(db, { organizationId: scope.organizationId, clientId: period.clientId, month: period.month, year: period.year });
    const inPeriod = { periodId: scope.periodId, organizationId: scope.organizationId };

    const [modeled, legacy] = await Promise.all([
        db.invoice.groupBy({
            by: ["category", "voucherCode"],
            where: { ...inPeriod, ...MODELED },
            _count: { _all: true },
            _sum: {
                netAmount: true, vatAmount: true, totalAmount: true, taxedNetAmount: true, totalVatAmount: true,
                netWithoutVatBreakdownAmount: true, directComputableVatCreditAmount: true,
                grossIncomeTaxBaseAmount: true, voucherTotalAmount: true,
            },
            orderBy: [{ category: "asc" }, { voucherCode: "asc" }],
        }),
        db.invoice.groupBy({
            by: ["category"],
            where: { ...inPeriod, NOT: MODELED },
            _count: { _all: true },
            _sum: { netAmount: true, vatAmount: true, totalAmount: true },
            orderBy: { category: "asc" },
        }),
    ]);

    // IVA sujeto a prorrateo global de las compras modeladas, por código (el signo sale del código).
    const purchaseCodes = modeled.filter((g) => g.category === "PURCHASES").map((g) => g.voucherCode as number);
    const globalByCode = new Map(
        await Promise.all(
            purchaseCodes.map(async (code) => {
                const agg = await db.invoiceVatLine.aggregate({
                    where: { creditAllocation: "GLOBAL_PRORATION", invoice: { ...inPeriod, ...MODELED, category: "PURCHASES", voucherCode: code } },
                    _count: { _all: true },
                    _sum: { vatAmount: true },
                });
                return [code, agg] as const;
            }),
        ),
    );

    const invoices: InvoiceForCalc[] = [
        // Filas heredadas: sólo neto, IVA y total (como en normalizeInvoiceRow).
        ...legacy.map((g) => ({ category: g.category, netAmount: z(g._sum.netAmount), vatAmount: z(g._sum.vatAmount), totalAmount: z(g._sum.totalAmount) })),
        ...modeled.map((g) => {
            const row: InvoiceForCalc = {
                category: g.category,
                netAmount: z(g._sum.netAmount),
                vatAmount: z(g._sum.vatAmount),
                totalAmount: z(g._sum.totalAmount),
                voucherCode: g.voucherCode,
                taxedNetAmount: z(g._sum.taxedNetAmount),
                totalVatAmount: z(g._sum.totalVatAmount),
                netWithoutVatBreakdownAmount: z(g._sum.netWithoutVatBreakdownAmount),
                directComputableVatCreditAmount: z(g._sum.directComputableVatCreditAmount),
                grossIncomeTaxBaseAmount: g.category === "SALES" ? z(g._sum.grossIncomeTaxBaseAmount) : g._sum.grossIncomeTaxBaseAmount,
                voucherTotalAmount: z(g._sum.voucherTotalAmount),
            };
            if (g.category === "PURCHASES") {
                const gl = globalByCode.get(g.voucherCode as number);
                row.vatLines = gl && gl._count._all > 0 ? [{ vatAmount: z(gl._sum.vatAmount), creditAllocation: "GLOBAL_PRORATION" }] : [];
            }
            return row;
        }),
    ];

    // IIBB por actividad: sólo contribuyente LOCAL de una jurisdicción con actividades cargadas.
    const jur = localIibbJurisdiction(period.client);
    let iibbActivities: PeriodForCalc["iibbActivities"] = null;
    if (jur && period.client.activities.length > 0) {
        const [modeledSales, legacySales] = await Promise.all([
            db.invoice.groupBy({
                by: ["voucherCode", "pointOfSale", "iibbActivityCode"],
                where: { ...inPeriod, ...MODELED, category: "SALES" },
                _sum: { grossIncomeTaxBaseAmount: true },
                orderBy: [{ voucherCode: "asc" }, { pointOfSale: "asc" }, { iibbActivityCode: "asc" }],
            }),
            db.invoice.groupBy({
                by: ["pointOfSale", "iibbActivityCode"],
                where: { ...inPeriod, NOT: MODELED, category: "SALES" },
                _sum: { netAmount: true },
                orderBy: [{ pointOfSale: "asc" }, { iibbActivityCode: "asc" }],
            }),
        ]);
        // Misma base con signo que la liquidación (normalizeInvoiceRow).
        const slices: IibbSaleSlice[] = [
            ...modeledSales.map((g) => ({
                pointOfSale: g.pointOfSale,
                manualCode: g.iibbActivityCode,
                base: normalizeInvoiceRow({
                    category: "SALES", netAmount: ZERO, vatAmount: ZERO, totalAmount: ZERO, voucherCode: g.voucherCode,
                    taxedNetAmount: ZERO, totalVatAmount: ZERO, netWithoutVatBreakdownAmount: ZERO, directComputableVatCreditAmount: ZERO,
                    grossIncomeTaxBaseAmount: z(g._sum.grossIncomeTaxBaseAmount), voucherTotalAmount: ZERO,
                }).grossIncomeTaxBase,
            })),
            ...legacySales.map((g) => ({ pointOfSale: g.pointOfSale, manualCode: g.iibbActivityCode, base: z(g._sum.netAmount) })),
        ];
        // F2: alícuota del año del período; si no está confirmada, la de la ficha (con advertencia).
        const yearRows = await db.clientIibbRateYear.findMany({
            where: { clientId: period.clientId, organizationId: scope.organizationId, fiscalYear: period.year, jurisdictionCode: jur },
            select: { jurisdictionCode: true, activityCode: true, rate: true, treatment: true, minimumAmount: true, additionalLabel: true, additionalRate: true },
        });
        const yearMap = new Map(yearRows.map((r) => [rateYearKey(r), r]));
        const { costs, pendingCount } = await iibbProviderCosts(db, { organizationId: scope.organizationId, periodId: scope.periodId, clientId: period.clientId });
        iibbActivities = {
            slices,
            config: {
                jurisdictionCode: jur,
                fiscalYear: period.year,
                principalCode: period.client.iibbPrincipalActivityCode,
                posMap: Object.fromEntries(period.client.posActivities.map((p) => [p.pointOfSale, p.activityCode])),
                ...(Object.keys(costs).length > 0 ? { costs } : {}),
                ...(pendingCount > 0 ? { pendingCostInvoices: pendingCount } : {}),
                activities: period.client.activities.map((a) => {
                    const r = a.rates.find((x) => x.jurisdictionCode === jur);
                    return { code: a.code, description: a.description, ...pickYearRate(yearMap, r, jur, a.code) };
                }),
            },
        };
    }

    return {
        iibbActivities,
        invoices,
        taxRecords: period.taxRecords,
        client: { defaultIibbRate: period.client.defaultIibbRate, iibbJurisdiction: localIibbJurisdiction(period.client) },
        iibbPosition: iibbPositionWithPrevious(period.iibbPosition, auto),
        iibbPreviousBalanceAuto: period.iibbPosition ? null : auto,
        vatSettings: period.vatSettings,
        vatCreditAdjustments: period.vatCreditAdjustments,
        invoiceCount: [...modeled, ...legacy].reduce((n, g) => n + g._count._all, 0),
    };
}

/**
 * IIBB F2: base de IIBB de las ventas registradas en la app para un año (todas
 * las jurisdicciones; mismo signo que la liquidación). Es sólo una REFERENCIA
 * para cargar los ingresos anuales: la app puede no tener todos los períodos ni
 * los ingresos que no pasan por ella.
 */
export async function salesIibbBaseForYear(
    db: Pick<PrismaClient, "invoice" | "period">,
    scope: { organizationId: string; clientId: string; year: number },
): Promise<{ base: Prisma.Decimal; periods: number }> {
    const where = { organizationId: scope.organizationId, category: "SALES", period: { clientId: scope.clientId, year: scope.year } };
    const [periods, modeled, legacy] = await Promise.all([
        db.period.count({ where: { organizationId: scope.organizationId, clientId: scope.clientId, year: scope.year } }),
        db.invoice.groupBy({ by: ["voucherCode"], where: { ...where, ...MODELED }, _sum: { grossIncomeTaxBaseAmount: true }, orderBy: { voucherCode: "asc" } }),
        db.invoice.aggregate({ where: { ...where, NOT: MODELED }, _sum: { netAmount: true } }),
    ]);
    const modeledBase = modeled.map(
        (g) =>
            normalizeInvoiceRow({
                category: "SALES", netAmount: ZERO, vatAmount: ZERO, totalAmount: ZERO, voucherCode: g.voucherCode,
                taxedNetAmount: ZERO, totalVatAmount: ZERO, netWithoutVatBreakdownAmount: ZERO, directComputableVatCreditAmount: ZERO,
                grossIncomeTaxBaseAmount: z(g._sum.grossIncomeTaxBaseAmount), voucherTotalAmount: ZERO,
            }).grossIncomeTaxBase,
    );
    return { base: sum([...modeledBase, z(legacy._sum.netAmount)]), periods };
}
