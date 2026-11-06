import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isoDate } from "../invoice-model";
import type { PeriodForCalc } from "../liquidation-calc";
import type { PackageVatAdjustment } from "./package";
import type { ExportInvoice, ExportSettings, ExportTaxRecord } from "./types";

/**
 * Carga del período para los exportadores y el cierre: comprobantes con sus
 * líneas EN LOTES (cursor por id, `BATCH` filas por consulta) para no armar una
 * única consulta gigante, retenciones/percepciones, configuración, ajustes e
 * identificación del cliente. Filtra SIEMPRE por período y organización (el
 * llamador ya autorizó el acceso). Sirve con el cliente global o con el de una
 * transacción (cierre bajo el bloqueo del Period).
 */

const BATCH = 1000;

type Db = Pick<PrismaClient, "period" | "invoice">;

export interface PeriodExportData {
    period: { id: string; clientId: string; month: number; year: number; status: string; updatedAt: Date };
    client: { name: string; cuit: string; defaultIibbRate: Prisma.Decimal };
    settings: ExportSettings & {
        globalCoefficient: Prisma.Decimal | null;
        previousTechnicalBalance: Prisma.Decimal;
        previousTechnicalBalanceReference: string | null;
        previousFreeBalance: Prisma.Decimal;
        previousFreeBalanceReference: string | null;
    };
    adjustments: PackageVatAdjustment[];
    invoices: ExportInvoice[];
    taxRecords: ExportTaxRecord[];
    /** Entrada del motor único (computeLiquidation) con las MISMAS filas. */
    calc: PeriodForCalc;
}

const INVOICE_SELECT = {
    id: true, category: true, voucherCode: true, pointOfSale: true, number: true, numberTo: true, voucherDate: true,
    counterpartyDocType: true, counterpartyDocNumber: true, counterpartyName: true, counterpartyVatConditionCode: true,
    currencyCode: true, exchangeRate: true, taxedNetAmount: true, totalVatAmount: true, directComputableVatCreditAmount: true,
    netWithoutVatBreakdownAmount: true, nonTaxedAmount: true, exemptAmount: true, vatPerceptionAmount: true,
    nationalPerceptionAmount: true, iibbPerceptionAmount: true, municipalPerceptionAmount: true, internalTaxesAmount: true,
    otherTaxesAmount: true, voucherTotalAmount: true, turivaRefundAmount: true, lidSection: true, operationCode: true,
    activityCode: true, saleOperationType: true, buyerType: true, purchaseCreditConcept: true, dationInPayment: true,
    grossIncomeTaxBaseAmount: true, netAmount: true, vatAmount: true, totalAmount: true,
    vatLines: {
        select: { vatRateCode: true, netAmount: true, vatAmount: true, creditAllocation: true, computableVatAmount: true },
        orderBy: [{ vatRateCode: "asc" as const }, { creditAllocation: "asc" as const }],
    },
} satisfies Prisma.InvoiceSelect;

export async function loadPeriodExportData(db: Db, scope: { organizationId: string; periodId: string }): Promise<PeriodExportData | null> {
    const p = await db.period.findFirst({
        where: { id: scope.periodId, organizationId: scope.organizationId },
        select: {
            id: true, clientId: true, month: true, year: true, status: true, updatedAt: true,
            client: { select: { name: true, cuit: true, defaultIibbRate: true } },
            vatSettings: { select: { creditProrationMode: true, globalCoefficient: true, turivaIncluded: true, previousTechnicalBalance: true, previousTechnicalBalanceReference: true, previousFreeBalance: true, previousFreeBalanceReference: true } },
            vatCreditAdjustments: { select: { regime: true, contributionsAmount: true, computableAmount: true, reference: true }, orderBy: { regime: "asc" } },
            taxRecords: {
                select: { id: true, date: true, type: true, amount: true, nature: true, taxCode: true, regimeCode: true, agentCuit: true, intermediaryCuit: true, voucherTypeCode: true, voucherNumber: true, certificateNumber: true, customsDocument: true, invoiceId: true },
                orderBy: { id: "asc" },
            },
        },
    });
    if (!p) return null;

    type Row = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;
    const rows: Row[] = [];
    let cursor: string | null = null;
    for (;;) {
        const batch: Row[] = await db.invoice.findMany({
            where: { periodId: scope.periodId, organizationId: scope.organizationId },
            select: INVOICE_SELECT,
            orderBy: { id: "asc" },
            take: BATCH,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        rows.push(...batch);
        if (batch.length < BATCH) break;
        cursor = batch[batch.length - 1].id;
    }

    const s = p.vatSettings;
    const settings: PeriodExportData["settings"] = {
        creditProrationMode: s?.creditProrationMode ?? "NONE",
        globalCoefficient: s?.globalCoefficient ?? null,
        turivaIncluded: s?.turivaIncluded ?? false,
        previousTechnicalBalance: s?.previousTechnicalBalance ?? new Prisma.Decimal(0),
        previousTechnicalBalanceReference: s?.previousTechnicalBalanceReference ?? null,
        previousFreeBalance: s?.previousFreeBalance ?? new Prisma.Decimal(0),
        previousFreeBalanceReference: s?.previousFreeBalanceReference ?? null,
    };

    const invoices: ExportInvoice[] = rows.map((r) => ({
        id: r.id, category: r.category, voucherCode: r.voucherCode, pointOfSale: r.pointOfSale, number: r.number, numberTo: r.numberTo,
        voucherDate: isoDate(r.voucherDate), counterpartyDocType: r.counterpartyDocType, counterpartyDocNumber: r.counterpartyDocNumber,
        counterpartyName: r.counterpartyName, counterpartyVatConditionCode: r.counterpartyVatConditionCode, currencyCode: r.currencyCode,
        exchangeRate: r.exchangeRate, taxedNetAmount: r.taxedNetAmount, totalVatAmount: r.totalVatAmount,
        directComputableVatCreditAmount: r.directComputableVatCreditAmount, netWithoutVatBreakdownAmount: r.netWithoutVatBreakdownAmount,
        nonTaxedAmount: r.nonTaxedAmount, exemptAmount: r.exemptAmount, vatPerceptionAmount: r.vatPerceptionAmount,
        nationalPerceptionAmount: r.nationalPerceptionAmount, iibbPerceptionAmount: r.iibbPerceptionAmount,
        municipalPerceptionAmount: r.municipalPerceptionAmount, internalTaxesAmount: r.internalTaxesAmount, otherTaxesAmount: r.otherTaxesAmount,
        voucherTotalAmount: r.voucherTotalAmount, turivaRefundAmount: r.turivaRefundAmount, lidSection: r.lidSection, operationCode: r.operationCode,
        activityCode: r.activityCode, saleOperationType: r.saleOperationType, buyerType: r.buyerType, purchaseCreditConcept: r.purchaseCreditConcept,
        dationInPayment: r.dationInPayment,
        vatLines: r.vatLines,
    }));
    const taxRecords: ExportTaxRecord[] = p.taxRecords.map((t) => ({ ...t, date: isoDate(t.date)! }));

    return {
        period: { id: p.id, clientId: p.clientId, month: p.month, year: p.year, status: p.status, updatedAt: p.updatedAt },
        client: p.client,
        settings,
        adjustments: p.vatCreditAdjustments,
        invoices,
        taxRecords,
        calc: {
            invoices: rows,
            taxRecords: p.taxRecords,
            client: { defaultIibbRate: p.client.defaultIibbRate },
            vatSettings: s ? { creditProrationMode: s.creditProrationMode, globalCoefficient: s.globalCoefficient, previousTechnicalBalance: s.previousTechnicalBalance, previousFreeBalance: s.previousFreeBalance } : null,
            vatCreditAdjustments: p.vatCreditAdjustments,
        },
    };
}

/**
 * Huella del CONTENIDO del período (lo que el cierre bloquea): comprobantes
 * con líneas y clasificaciones, retenciones/percepciones, configuración de IVA
 * y ajustes, en un orden canónico. Se guarda en el cierre y se recalcula antes
 * de entregar la versión final: si no coincide, el contenido cambió por fuera
 * del bloqueo y la descarga se rechaza. La ficha del cliente NO entra (se puede
 * editar con el período cerrado): su identificación al cierre queda en el
 * resumen de la versión y en el paquete guardado.
 */
export function contentHash(d: Pick<PeriodExportData, "invoices" | "taxRecords" | "settings" | "adjustments" | "period">): string {
    const h = createHash("sha256");
    const put = (v: unknown) => h.update(JSON.stringify(v, (_k, x) => (x instanceof Prisma.Decimal ? x.toFixed() : x)) + "\n");
    put(["period", d.period.id, d.period.month, d.period.year]);
    put(["settings", d.settings]);
    for (const a of d.adjustments) put(["adjustment", a]);
    for (const i of [...d.invoices].sort((a, b) => a.id.localeCompare(b.id))) put(["invoice", i]);
    for (const t of [...d.taxRecords].sort((a, b) => a.id.localeCompare(b.id))) put(["tax", t]);
    return h.digest("hex");
}
