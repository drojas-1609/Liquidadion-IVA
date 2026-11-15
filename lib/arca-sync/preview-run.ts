import { createHash } from "node:crypto";
import {
    consumerFinalRows, invoiceVariant, sameVariant, taxVariant,
    type InvoicePreviewJson, type SyncPreviewSummary, type SyncVariant, type TaxPreviewJson,
} from "./preview";

/**
 * Vista previa y confirmación de los archivos descargados de ARCA con el
 * importador existente. No lee ni escribe por su cuenta: llama a las rutas de
 * importación (que validan permisos, período, duplicados y auditoría) a través
 * de `invoke`, y nunca confirma sin que se lo pidan.
 */

export type SyncSource = "SALES" | "PURCHASES" | "RETENTIONS" | "PERCEPTIONS";
export interface SyncFile { content: Uint8Array; format: string | null; sha256: string }
export type ImporterCall = "INVOICE_PREVIEW" | "INVOICE_CONFIRM" | "TAX";
export type Invoke = (call: ImporterCall, body: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown }>;

export class ImportRejectedError extends Error {
    constructor(readonly reason: "preview-status" | "file-errors") {
        super("IMPORT_REJECTED");
        this.name = "ImportRejectedError";
    }
}
export class PreviewChangedError extends Error {
    constructor(readonly summary: SyncPreviewSummary) {
        super("PREVIEW_CHANGED");
        this.name = "PreviewChangedError";
    }
}
export class ConfirmFailedError extends Error {
    constructor() {
        super("CONFIRM_FAILED");
        this.name = "ConfirmFailedError";
    }
}

export const fileSha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isInvoices = (source: SyncSource) => source === "SALES" || source === "PURCHASES";

function invoiceBody(task: { source: SyncSource; clientId: string }, file: SyncFile, consumerFinalLegend: boolean) {
    return {
        clientId: task.clientId, category: task.source, format: file.format ?? "PORTAL_CSV",
        vouchersFile: Buffer.from(file.content).toString("base64"), acceptPartial: true,
        ...(consumerFinalLegend ? { consumerFinalLegend: true } : {}),
    };
}
const taxBody = (task: { source: SyncSource }, file: SyncFile) => ({ kind: task.source, file: Buffer.from(file.content).toString("base64") });

async function preview<T extends { fileErrors?: string[]; token: string }>(invoke: Invoke, call: ImporterCall, body: Record<string, unknown>) {
    const response = await invoke(call, body);
    if (!response.ok) throw new ImportRejectedError("preview-status");
    const data = response.data as T;
    if (data.fileErrors?.length) throw new ImportRejectedError("file-errors");
    return data;
}

type InvoiceData = InvoicePreviewJson & { token: string; fileErrors?: string[] };
type TaxData = TaxPreviewJson & { token: string; fileErrors?: string[] };

interface Computed {
    summary: SyncPreviewSummary;
    /** Datos para confirmar la variante elegida, por archivo. */
    confirmable: (consumerFinalLegend: boolean) => Array<{ file: SyncFile; index: number; token: string; ok: number; legend: boolean }>;
    variant: (consumerFinalLegend: boolean) => SyncVariant;
}

async function compute(task: { source: SyncSource; clientId: string }, files: readonly SyncFile[], invoke: Invoke): Promise<Computed> {
    const described = files.map((file) => ({ sha256: file.sha256, format: file.format }));
    if (isInvoices(task.source)) {
        // Los libros llegan en un único archivo por fuente.
        if (files.length !== 1) throw new ImportRejectedError("file-errors");
        const file = files[0];
        const base = await preview<InvoiceData>(invoke, "INVOICE_PREVIEW", invoiceBody(task, file, false));
        const summary: SyncPreviewSummary = { version: 1, files: described, ...invoiceVariant(base) };
        const suggested = task.source === "SALES" ? consumerFinalRows(base) : 0;
        let legend: InvoiceData | null = null;
        if (suggested > 0) {
            legend = await preview<InvoiceData>(invoke, "INVOICE_PREVIEW", invoiceBody(task, file, true));
            summary.consumerFinal = { rows: suggested, ...invoiceVariant(legend) };
        }
        return {
            summary,
            variant: (withLegend) => (withLegend && summary.consumerFinal ? summary.consumerFinal : summary),
            confirmable: (withLegend) => {
                const chosen = withLegend && legend ? legend : base;
                return [{ file, index: 0, token: chosen.token, ok: chosen.reconciliation.statusCounts.OK, legend: withLegend && legend !== null }];
            },
        };
    }
    const previews: TaxData[] = [];
    for (const file of files) previews.push(await preview<TaxData>(invoke, "TAX", { ...taxBody(task, file), confirm: false }));
    const summary: SyncPreviewSummary = { version: 1, files: described, ...taxVariant(previews) };
    return {
        summary,
        variant: () => summary,
        confirmable: () => previews.map((data, index) => ({ file: files[index], index, token: data.token, ok: data.counts.OK, legend: false })),
    };
}

export async function buildSyncPreview(task: { source: SyncSource; clientId: string }, files: readonly SyncFile[], invoke: Invoke) {
    return (await compute(task, files, invoke)).summary;
}

/** Identificador estable de la operación: un reintento de la misma confirmación no duplica. */
export function operationIdFor(taskId: string, index: number, sha256: string, legend: boolean) {
    const hex = createHash("sha256").update(taskId).update(String(index)).update(sha256).update(legend ? "legend" : "").digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Confirma lo que el usuario vio. Recalcula la vista previa con el estado
 * actual: si cambió (otra carga, otro período), no escribe y devuelve la nueva.
 */
export async function confirmSyncPreview(
    task: { id: string; source: SyncSource; clientId: string },
    files: readonly SyncFile[],
    seen: SyncPreviewSummary,
    options: { consumerFinalLegend: boolean },
    invoke: Invoke,
) {
    const current = await compute(task, files, invoke);
    const legend = options.consumerFinalLegend && current.summary.consumerFinal !== undefined;
    const seenVariant = options.consumerFinalLegend && seen.consumerFinal ? seen.consumerFinal : seen;
    if (options.consumerFinalLegend !== legend || !sameVariant(seenVariant, current.variant(legend))) throw new PreviewChangedError(current.summary);
    let imported = 0;
    for (const item of current.confirmable(legend)) {
        if (!(item.ok > 0)) continue;
        const operationId = operationIdFor(task.id, item.index, item.file.sha256, item.legend);
        const response = isInvoices(task.source)
            ? await invoke("INVOICE_CONFIRM", { ...invoiceBody(task, item.file, item.legend), token: item.token, operationId })
            : await invoke("TAX", { ...taxBody(task, item.file), token: item.token, confirm: true });
        if (!response.ok) throw new ConfirmFailedError();
        imported += Number((response.data as { imported?: number }).imported ?? 0);
    }
    const variant = current.variant(legend);
    return { imported, variant, summary: { ...current.summary, confirmed: { consumerFinalLegend: legend, imported } } satisfies SyncPreviewSummary };
}
