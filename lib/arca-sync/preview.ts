/**
 * Resumen de la vista previa de una fuente descargada de ARCA (lógica pura).
 * Lo arma la ruta interna con la respuesta del importador existente y lo
 * muestra el panel de «Importar ahora» antes de la confirmación. Guarda sólo
 * conteos, totales y motivos agrupados: nunca filas, CUIT ni denominaciones.
 */

export type SyncRowStatus = "OK" | "DUPLICATE" | "REVIEW" | "ERROR";
export type SyncCounts = Record<SyncRowStatus, number>;

export interface SyncReason {
    status: Exclude<SyncRowStatus, "OK">;
    message: string;
    rows: number;
}

/** Importes como texto con dos decimales (los mismos que informa el importador). */
export interface SyncInvoiceTotals {
    /** Filas aptas, con signo contable (las notas de crédito restan). */
    importable: { taxedNet: string; vat: string; nonTaxed: string; exempt: string; otherTaxes: string; total: string };
    /** Filas aptas por alícuota (código de la tabla oficial). */
    byRate: Array<{ code: string; net: string; vat: string }>;
    pendingTotal: string;
    duplicateTotal: string;
    errorInformedTotal: string;
}

export interface SyncVariant {
    counts: SyncCounts;
    reasons: SyncReason[];
    invoices?: SyncInvoiceTotals;
    taxes?: { importableTotal: string; excludedTotal: string };
}

export interface SyncPreviewSummary extends SyncVariant {
    version: 1;
    files: Array<{ sha256: string; format: string | null }>;
    /**
     * Sólo ventas: resultado si se aplica la leyenda «CONSUMIDOR FINAL» a las
     * filas con documento 99 sin denominación. `rows` es cuántas la reciben.
     */
    consumerFinal?: SyncVariant & { rows: number };
    /** Se completa al confirmar. */
    confirmed?: { consumerFinalLegend: boolean; imported: number };
}

const REASON_LIMIT = 12;
/** Marca del motivo que la sugerencia «CONSUMIDOR FINAL» resuelve (lib/libro-iva-import/build.ts). */
export const CONSUMER_FINAL_MARK = "se puede aplicar la leyenda «CONSUMIDOR FINAL»";

const ZERO = BigInt(0), HUNDRED = BigInt(100);
const cents = (value: string | undefined | null) => {
    const match = /^(-?)(\d+)\.(\d{2})$/.exec(value ?? "0.00");
    if (!match) return ZERO;
    const amount = BigInt(match[2]) * HUNDRED + BigInt(match[3]);
    return match[1] ? -amount : amount;
};
const money = (value: bigint) => {
    const abs = value < ZERO ? -value : value;
    return `${value < ZERO ? "-" : ""}${abs / HUNDRED}.${String(abs % HUNDRED).padStart(2, "0")}`;
};
export const addMoney = (a: string, b: string) => money(cents(a) + cents(b));

/** Agrupa por motivo: los importes y números de línea del mensaje no distinguen grupos. */
export function reasonKey(message: string) {
    return message.replace(/-?\d+[.,]\d{2}(?!\d)/g, "…").replace(/\b(línea|líneas) [\d, …]+/g, "$1 …").replace(/\s+/g, " ").trim();
}

export function groupReasons(rows: ReadonlyArray<{ status: string; messages: readonly string[] }>): SyncReason[] {
    const groups = new Map<string, SyncReason>();
    for (const row of rows) {
        if (row.status !== "REVIEW" && row.status !== "ERROR" && row.status !== "DUPLICATE") continue;
        for (const message of new Set(row.messages.map(reasonKey))) {
            const key = `${row.status}|${message}`;
            const group = groups.get(key) ?? { status: row.status, message, rows: 0 };
            group.rows++;
            groups.set(key, group);
        }
    }
    const ordered = [...groups.values()].sort((a, b) => b.rows - a.rows || a.message.localeCompare(b.message));
    if (ordered.length <= REASON_LIMIT) return ordered;
    const rest = ordered.slice(REASON_LIMIT - 1);
    return [...ordered.slice(0, REASON_LIMIT - 1), { status: "REVIEW", message: `otros ${rest.length} motivos`, rows: rest.reduce((n, r) => n + r.rows, 0) }];
}

type Totals = Record<string, string | number>;
export interface InvoicePreviewJson {
    rows: Array<{ status: string; messages: string[] }>;
    reconciliation: {
        statusCounts: SyncCounts;
        importable: { CONSOLIDATED: Totals };
        byRate: Record<string, { net: string; vat: string }>;
        notImported: { REVIEW: Totals; DUPLICATE: Totals; ERROR: { informedTotal: string } };
    };
}
export interface TaxPreviewJson {
    rows: Array<{ status: string; messages: string[] }>;
    counts: SyncCounts;
    importableTotal: string;
    excludedTotal: string;
}

export function invoiceVariant(preview: InvoicePreviewJson): SyncVariant {
    const rec = preview.reconciliation;
    const ok = rec.importable.CONSOLIDATED;
    const text = (totals: Totals, key: string) => String(totals[key] ?? "0.00");
    return {
        counts: { ...rec.statusCounts },
        reasons: groupReasons(preview.rows),
        invoices: {
            importable: {
                taxedNet: text(ok, "taxedNet"), vat: text(ok, "vat"), nonTaxed: text(ok, "nonTaxed"), exempt: text(ok, "exempt"),
                otherTaxes: [ok.vatPerception, ok.nationalPerception, ok.iibbPerception, ok.municipalPerception, ok.internalTaxes, ok.otherTaxes]
                    .reduce<string>((sum, value) => addMoney(sum, String(value ?? "0.00")), "0.00"),
                total: text(ok, "total"),
            },
            byRate: Object.entries(rec.byRate).sort(([a], [b]) => a.localeCompare(b)).map(([code, value]) => ({ code, net: value.net, vat: value.vat })),
            pendingTotal: text(rec.notImported.REVIEW, "total"),
            duplicateTotal: text(rec.notImported.DUPLICATE, "total"),
            errorInformedTotal: rec.notImported.ERROR.informedTotal,
        },
    };
}

export function taxVariant(previews: readonly TaxPreviewJson[]): SyncVariant {
    const counts: SyncCounts = { OK: 0, DUPLICATE: 0, REVIEW: 0, ERROR: 0 };
    let importableTotal = "0.00", excludedTotal = "0.00";
    for (const preview of previews) {
        for (const status of Object.keys(counts) as SyncRowStatus[]) counts[status] += preview.counts[status] ?? 0;
        importableTotal = addMoney(importableTotal, preview.importableTotal);
        excludedTotal = addMoney(excludedTotal, preview.excludedTotal);
    }
    return { counts, reasons: groupReasons(previews.flatMap((preview) => preview.rows)), taxes: { importableTotal, excludedTotal } };
}

/** Filas que recibirían la leyenda «CONSUMIDOR FINAL». */
export function consumerFinalRows(preview: InvoicePreviewJson) {
    return preview.rows.filter((row) => row.messages.some((message) => message.includes(CONSUMER_FINAL_MARK))).length;
}

/** ¿La vista previa recalculada coincide con la que vio el usuario? */
export function sameVariant(a: SyncVariant, b: SyncVariant) {
    return JSON.stringify([a.counts, a.invoices ?? null, a.taxes ?? null]) === JSON.stringify([b.counts, b.invoices ?? null, b.taxes ?? null]);
}
