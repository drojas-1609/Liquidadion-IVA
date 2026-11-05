import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { InvoiceForCalc, PeriodForCalc } from "./liquidation-calc";

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
}

const ZERO = new Prisma.Decimal(0);
const z = (v: Prisma.Decimal | null | undefined) => v ?? ZERO;

type Db = Pick<PrismaClient, "period" | "invoice" | "invoiceVatLine">;

export async function loadPeriodLiquidationInput(db: Db, scope: PeriodLiquidationScope): Promise<PeriodLiquidationInput | null> {
    const period = await db.period.findFirst({
        where: { id: scope.periodId, organizationId: scope.organizationId },
        select: {
            taxRecords: { select: { type: true, amount: true } },
            client: { select: { defaultIibbRate: true } },
            vatSettings: { select: { creditProrationMode: true, globalCoefficient: true } },
        },
    });
    if (!period) return null;
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

    return {
        invoices,
        taxRecords: period.taxRecords,
        client: period.client,
        vatSettings: period.vatSettings,
        invoiceCount: [...modeled, ...legacy].reduce((n, g) => n + g._count._all, 0),
    };
}
