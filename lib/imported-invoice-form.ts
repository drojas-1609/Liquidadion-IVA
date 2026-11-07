import { readApiError } from "./new-client-submit";

/**
 * Formulario de corrección DETALLADA de comprobantes importados (lógica sin
 * React, apta para el navegador). La autoridad es PATCH
 * /api/invoices/[id]/detail (lib/invoice-detail-edit): acá no se valida
 * ninguna regla fiscal, sólo se arma el cuerpo con TODO lo que tiene el
 * comprobante, sin simplificarlo.
 */

export const DETAILED_AMOUNT_LABELS = {
    netWithoutVatBreakdownAmount: "Neto sin IVA discriminado (compras B/C, ventas C)",
    nonTaxedAmount: "No gravado",
    exemptAmount: "Exento",
    vatPerceptionAmount: "Percepciones de IVA",
    nationalPerceptionAmount: "Percepciones de otros impuestos nacionales",
    iibbPerceptionAmount: "Percepciones de Ingresos Brutos",
    municipalPerceptionAmount: "Percepciones municipales",
    internalTaxesAmount: "Impuestos internos",
    otherTaxesAmount: "Otros tributos",
    turivaRefundAmount: "Reintegro TurIVA",
} as const;
export type DetailedAmountKey = keyof typeof DETAILED_AMOUNT_LABELS;

export interface ImportedLineValues {
    vatRateCode: number;
    netAmount: string;
    vatAmount: string;
    creditAllocation: string;
    computableVatAmount: string | null;
}

export interface ImportedInvoiceEditData {
    invoiceId: string;
    updatedAt: string;
    category: "SALES" | "PURCHASES";
    prorationMode: string;
    identity: {
        voucherLabel: string;
        voucherCode: number;
        pointOfSale: number;
        number: number;
        docType: number;
        docNumber: string;
        lidSection: "GENERAL" | "TURIVA";
        currencyCode: string;
    };
    values: {
        voucherDate: string;
        counterpartyName: string;
        counterpartyVatConditionCode: number | null;
        operationCode: string | null;
        amounts: Record<DetailedAmountKey, string>;
        reportedComputableVatCreditAmount: string | null;
        vatLines: ImportedLineValues[];
    };
    classifications: {
        activityCode: string | null;
        saleOperationType: string | null;
        buyerType: string | null;
        purchaseCreditConcept: string | null;
        dationInPayment: boolean;
    };
    totals: { taxedNet: string; vat: string; total: string };
}

/** Cuerpo del PATCH: contrato DETAILED_V1 con todos los valores del formulario. */
export function buildDetailedBody(values: ImportedInvoiceEditData["values"], expectedUpdatedAt: string, category: "SALES" | "PURCHASES") {
    return {
        contract: "DETAILED_V1",
        expectedUpdatedAt,
        voucherDate: values.voucherDate,
        counterpartyName: values.counterpartyName,
        counterpartyVatConditionCode: values.counterpartyVatConditionCode,
        operationCode: values.operationCode,
        amounts: values.amounts,
        reportedComputableVatCreditAmount: category === "PURCHASES" && values.reportedComputableVatCreditAmount !== "" ? values.reportedComputableVatCreditAmount : null,
        vatLines: values.vatLines.map((l) => ({
            vatRateCode: l.vatRateCode,
            netAmount: l.netAmount,
            vatAmount: l.vatAmount,
            creditAllocation: category === "SALES" ? "NOT_APPLICABLE" : l.creditAllocation,
            computableVatAmount: category === "PURCHASES" && l.creditAllocation !== "GLOBAL_PRORATION" && l.computableVatAmount !== "" ? l.computableVatAmount : null,
        })),
    };
}

/** Suma de control en el navegador (la que vale es la del servidor). Centavos enteros: sin errores de coma flotante. */
export function previewTotal(values: ImportedInvoiceEditData["values"]): string | null {
    const cents = (v: string) => (/^\d+(\.\d{1,2})?$/.test(v.trim()) ? Math.round(Number(v.trim()) * 100) : null);
    const parts = [
        ...values.vatLines.flatMap((l) => [l.netAmount, l.vatAmount]),
        ...(["netWithoutVatBreakdownAmount", "nonTaxedAmount", "exemptAmount", "vatPerceptionAmount", "nationalPerceptionAmount", "iibbPerceptionAmount", "municipalPerceptionAmount", "internalTaxesAmount", "otherTaxesAmount"] as const).map((k) => values.amounts[k]),
    ].map(cents);
    if (parts.some((p) => p === null)) return null;
    const total = (parts as number[]).reduce((a, b) => a + b, 0);
    return (total / 100).toFixed(2);
}

export type DetailedSubmitResult =
    | { ok: true }
    | { ok: false; field: string | null; message: string; stale: boolean };

export async function submitDetailedEdit(invoiceId: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<DetailedSubmitResult> {
    let res: Response;
    try {
        res = await fetchImpl(`/api/invoices/${encodeURIComponent(invoiceId)}/detail`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch {
        return { ok: false, field: null, message: "No se pudo guardar: revisá la conexión e intentá de nuevo.", stale: false };
    }
    if (res.ok) return { ok: true };
    const json: unknown = await res.json().catch(() => null);
    const err = readApiError(json);
    const stale = res.status === 409 && err?.code !== "PERIOD_CLOSED" && err?.code !== "PERIOD_BUSY" && /modificado por otra persona/.test(err?.message ?? "");
    const message =
        res.status === 403 ? "No tenés permisos para modificar comprobantes." :
        res.status === 404 ? "El comprobante no existe, fue eliminado o no pertenece a tu organización." :
        err?.message ?? "Ocurrió un error inesperado al guardar el comprobante.";
    const rawField = typeof json === "object" && json !== null ? (json as { error?: { field?: unknown } }).error?.field : undefined;
    return { ok: false, field: typeof rawField === "string" ? rawField : null, message, stale };
}
