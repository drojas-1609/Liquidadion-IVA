import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { InvoiceForCalc, PeriodForCalc } from "./liquidation-calc";
import { previousIibbBalance, iibbPositionWithPrevious, type PreviousIibbBalance } from "./iibb-previous-balance";
import { normalizeInvoiceRow, voucherSign } from "./invoice-model";
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

/**
 * Costo de prestadores del período por actividad (base por diferencia, criterio
 * del estudio): compras a los CUIT marcados, netas de IVA —gravado + no gravado
 * + exento + operaciones sin IVA discriminado (facturas C, por el total)— con el
 * signo del código (las notas de crédito restan). Filas heredadas: neto
 * registrado. Más el ajuste manual del período.
 */
export async function iibbProviderCosts(
    db: Pick<PrismaClient, "invoice" | "clientIibbProvider" | "periodIibbCostAdjustment">,
    scope: { organizationId: string; periodId: string; clientId: string },
): Promise<{ costs: Record<string, { providers: Prisma.Decimal; adjustment: Prisma.Decimal }>; byProvider: Array<{ cuit: string; name: string; activityCode: string; amount: Prisma.Decimal; count: number }> }> {
    const [providers, adjustments] = await Promise.all([
        db.clientIibbProvider.findMany({ where: { clientId: scope.clientId, organizationId: scope.organizationId }, select: { cuit: true, name: true, activityCode: true }, orderBy: { name: "asc" } }),
        db.periodIibbCostAdjustment.findMany({ where: { periodId: scope.periodId, organizationId: scope.organizationId }, select: { activityCode: true, amount: true } }),
    ]);
    const costs: Record<string, { providers: Prisma.Decimal; adjustment: Prisma.Decimal }> = {};
    const add = (code: string, k: "providers" | "adjustment", v: Prisma.Decimal) => {
        const c = (costs[code] ??= { providers: ZERO, adjustment: ZERO });
        c[k] = c[k].plus(v);
    };
    const byProvider: Array<{ cuit: string; name: string; activityCode: string; amount: Prisma.Decimal; count: number }> = [];
    if (providers.length > 0) {
        const cuits = providers.map((p) => p.cuit);
        const dashed = cuits.map((c) => `${c.slice(0, 2)}-${c.slice(2, 10)}-${c[10]}`);
        const inPeriod = { periodId: scope.periodId, organizationId: scope.organizationId, category: "PURCHASES" };
        const [modeled, legacy] = await Promise.all([
            db.invoice.groupBy({
                by: ["counterpartyDocNumber", "voucherCode"],
                where: { ...inPeriod, ...MODELED, counterpartyDocNumber: { in: cuits } },
                _count: { _all: true },
                _sum: { taxedNetAmount: true, netWithoutVatBreakdownAmount: true, nonTaxedAmount: true, exemptAmount: true },
                orderBy: [{ counterpartyDocNumber: "asc" }, { voucherCode: "asc" }],
            }),
            db.invoice.groupBy({
                by: ["entityCuit"],
                where: { ...inPeriod, NOT: MODELED, entityCuit: { in: [...cuits, ...dashed] } },
                _count: { _all: true },
                _sum: { netAmount: true },
                orderBy: { entityCuit: "asc" },
            }),
        ]);
        for (const p of providers) {
            let amount = ZERO;
            let count = 0;
            for (const g of modeled.filter((g) => g.counterpartyDocNumber === p.cuit)) {
                const net = z(g._sum.taxedNetAmount).plus(z(g._sum.netWithoutVatBreakdownAmount)).plus(z(g._sum.nonTaxedAmount)).plus(z(g._sum.exemptAmount));
                amount = amount.plus(net.times(voucherSign(g.voucherCode as number)));
                count += g._count._all;
            }
            for (const g of legacy.filter((g) => (g.entityCuit ?? "").replace(/-/g, "") === p.cuit)) {
                amount = amount.plus(z(g._sum.netAmount));
                count += g._count._all;
            }
            byProvider.push({ ...p, amount, count });
            add(p.activityCode, "providers", amount);
        }
    }
    for (const a of adjustments) add(a.activityCode, "adjustment", a.amount);
    return { costs, byProvider };
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
        const { costs } = await iibbProviderCosts(db, { organizationId: scope.organizationId, periodId: scope.periodId, clientId: period.clientId });
        iibbActivities = {
            slices,
            config: {
                jurisdictionCode: jur,
                fiscalYear: period.year,
                principalCode: period.client.iibbPrincipalActivityCode,
                posMap: Object.fromEntries(period.client.posActivities.map((p) => [p.pointOfSale, p.activityCode])),
                ...(Object.keys(costs).length > 0 ? { costs } : {}),
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
