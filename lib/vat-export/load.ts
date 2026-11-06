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
 *
 * Esquema v1 con una lista EXPLÍCITA y fija de campos (no la forma de los
 * tipos): agregar un campo al cargador no cambia la huella de las versiones ya
 * cerradas. Cambiar esta lista exige un esquema nuevo (v2) y conservar el v1
 * para verificar las versiones anteriores.
 */
export const CONTENT_HASH_SCHEME = "v1";

const INVOICE_HASH_FIELDS = [
    "id", "category", "voucherCode", "pointOfSale", "number", "numberTo", "voucherDate", "counterpartyDocType", "counterpartyDocNumber",
    "counterpartyName", "counterpartyVatConditionCode", "currencyCode", "exchangeRate", "taxedNetAmount", "totalVatAmount",
    "directComputableVatCreditAmount", "netWithoutVatBreakdownAmount", "nonTaxedAmount", "exemptAmount", "vatPerceptionAmount",
    "nationalPerceptionAmount", "iibbPerceptionAmount", "municipalPerceptionAmount", "internalTaxesAmount", "otherTaxesAmount",
    "voucherTotalAmount", "turivaRefundAmount", "lidSection", "operationCode", "activityCode", "saleOperationType", "buyerType",
    "purchaseCreditConcept", "dationInPayment",
] as const;
const LINE_HASH_FIELDS = ["vatRateCode", "netAmount", "vatAmount", "creditAllocation", "computableVatAmount"] as const;
const TAX_HASH_FIELDS = [
    "id", "date", "type", "amount", "nature", "taxCode", "regimeCode", "agentCuit", "intermediaryCuit", "voucherTypeCode", "voucherNumber",
    "certificateNumber", "customsDocument", "invoiceId",
] as const;
const SETTINGS_HASH_FIELDS = [
    "creditProrationMode", "globalCoefficient", "turivaIncluded", "previousTechnicalBalance", "previousTechnicalBalanceReference",
    "previousFreeBalance", "previousFreeBalanceReference",
] as const;
const ADJUSTMENT_HASH_FIELDS = ["regime", "contributionsAmount", "computableAmount", "reference"] as const;

function pick(o: object, fields: readonly string[]): unknown[] {
    const r = o as Record<string, unknown>;
    return fields.map((f) => {
        const v = r[f];
        if (v === undefined || v === null) return null;
        if (v instanceof Prisma.Decimal) return v.toFixed();
        return v;
    });
}

export function contentHash(d: Pick<PeriodExportData, "invoices" | "taxRecords" | "settings" | "adjustments" | "period">): string {
    const h = createHash("sha256");
    const put = (v: unknown) => h.update(JSON.stringify(v) + "\n");
    put(["scheme", CONTENT_HASH_SCHEME]);
    put(["period", d.period.id, d.period.month, d.period.year]);
    put(["settings", pick(d.settings, SETTINGS_HASH_FIELDS)]);
    for (const a of [...d.adjustments].sort((x, y) => x.regime.localeCompare(y.regime))) put(["adjustment", pick(a, ADJUSTMENT_HASH_FIELDS)]);
    for (const i of [...d.invoices].sort((a, b) => a.id.localeCompare(b.id))) {
        const lines = [...i.vatLines]
            .map((l) => pick(l, LINE_HASH_FIELDS))
            .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
        put(["invoice", pick(i, INVOICE_HASH_FIELDS), lines]);
    }
    for (const t of [...d.taxRecords].sort((a, b) => a.id.localeCompare(b.id))) put(["tax", pick(t, TAX_HASH_FIELDS)]);
    return h.digest("hex");
}

/**
 * Esquema v0 (versiones cerradas antes de CONTENT_HASH_SCHEME, sin
 * `summary.hashScheme`): serializaba los objetos completos del cargador del
 * 06/11/2026. Se conserva SIN CAMBIOS sólo para verificar esas versiones; no se
 * usa para cerrar.
 */
export function contentHashV0(d: Pick<PeriodExportData, "invoices" | "taxRecords" | "settings" | "adjustments" | "period">): string {
    const h = createHash("sha256");
    const put = (v: unknown) => h.update(JSON.stringify(v, (_k, x) => (x instanceof Prisma.Decimal ? x.toFixed() : x)) + "\n");
    put(["period", d.period.id, d.period.month, d.period.year]);
    put(["settings", d.settings]);
    for (const a of d.adjustments) put(["adjustment", a]);
    for (const i of [...d.invoices].sort((a, b) => a.id.localeCompare(b.id))) put(["invoice", i]);
    for (const t of [...d.taxRecords].sort((a, b) => a.id.localeCompare(b.id))) put(["tax", t]);
    return h.digest("hex");
}

/** Huella con el esquema con que se cerró la versión (`summary.hashScheme`; ausente = v0). */
export function contentHashFor(scheme: unknown, d: Parameters<typeof contentHash>[0]): string | null {
    if (scheme === undefined || scheme === null) return contentHashV0(d);
    if (scheme === CONTENT_HASH_SCHEME) return contentHash(d);
    return null;
}
