import "server-only";
import type { Prisma, Role } from "@prisma/client";
import { VAT_RATES, VOUCHER_TYPES, VOUCHER_VARIANTS, type VoucherVariant } from "./arca/catalogs";
import { CODES_A, CODES_T } from "./arca/voucher-matrix";
import { isoDate, purchaseHasNoVatBreakdown, voucherSign, type InvoiceCategory } from "./invoice-model";
import { ROLES_DELETE, ROLES_UPDATE } from "./auth/roles";
import type { InvoiceV2Data } from "./api-input";
import type { ManualInvoiceData } from "./manual-invoice";
import type { InvoiceFormState } from "./invoice-form-client";

/**
 * Corrección de comprobantes manuales: alcance, editabilidad, eliminabilidad y
 * `changedFields`. Lógica pura (sin base de datos); la usan PATCH / DELETE
 * /api/invoices/[id] antes de la transacción y, de nuevo, sobre la fila
 * BLOQUEADA.
 */

/** Forma mínima de una fila para decidir qué se puede hacer con ella. */
export interface EditableInvoiceRow {
    /** SALES / PURCHASES: decide la estructura de líneas esperada. */
    category: string;
    source: string | null;
    voucherCode: number | null;
    voucherDate: Date | null;
    pointOfSale: number;
    number: number;
    counterpartyDocType: number | null;
    counterpartyDocNumber: string | null;
    counterpartyName: string | null;
    counterpartyVatConditionCode: number | null;
    voucherVariant: string | null;
    turivaRelationCode: string | null;
    taxedNetAmount: Prisma.Decimal | null;
    netWithoutVatBreakdownAmount: Prisma.Decimal | null;
    /** Códigos de alícuota de sus líneas de IVA (0, 1 o más). */
    vatRateCodes: readonly number[];
}

export type InvoiceScopeReason = "IMPORTED" | "LEGACY" | "MULTI_RATE";
export type InvoiceEditReason = InvoiceScopeReason | "INSUFFICIENT_DATA";

/** Mensajes estables por razón (422 field "invoice"). */
export const INVOICE_NOT_EDITABLE_MESSAGES: Readonly<Record<InvoiceEditReason, string>> = {
    IMPORTED: "El comprobante fue importado: no se puede corregir ni eliminar manualmente.",
    LEGACY: "El comprobante fue cargado con el formato anterior: no se puede corregir ni eliminar desde esta pantalla.",
    MULTI_RATE: "El comprobante tiene más de una alícuota de IVA: no se puede corregir ni eliminar desde esta pantalla.",
    INSUFFICIENT_DATA: "Al comprobante le faltan datos para reconstruir el formulario: no se puede corregir desde esta pantalla.",
};

export type InvoiceScope = { ok: true } | { ok: false; reason: InvoiceScopeReason };

/**
 * Alcance común de edición y baja: sólo filas MANUAL, con código oficial y
 * cero o una línea de IVA. Precedencia: IMPORTED > LEGACY > MULTI_RATE.
 */
export function invoiceScope(row: Pick<EditableInvoiceRow, "source" | "voucherCode" | "vatRateCodes">): InvoiceScope {
    if (row.source === "IMPORT") return { ok: false, reason: "IMPORTED" };
    if (row.source !== "MANUAL" || row.voucherCode === null) return { ok: false, reason: "LEGACY" };
    if (row.vatRateCodes.length > 1) return { ok: false, reason: "MULTI_RATE" };
    return { ok: true };
}

/** La baja no reconstruye el formulario: sólo aplica el alcance común. */
export function invoiceDeletability(row: Pick<EditableInvoiceRow, "source" | "voucherCode" | "vatRateCodes">): InvoiceScope {
    return invoiceScope(row);
}

export type InvoiceEditability =
    | { ok: true; requiresCounterpartyCondition: boolean; requiresVoucherVariant: boolean }
    | { ok: false; reason: InvoiceEditReason };

const isCodeIn = (codes: readonly number[], code: number) => codes.includes(code);
const nonEmpty = (v: string | null) => v !== null && v.trim() !== "";
const isCategory = (v: string): v is InvoiceCategory => v === "SALES" || v === "PURCHASES";

/**
 * Estructura de líneas que exige el modelo manual vigente (modelFromVoucher):
 * compras B/C sin IVA discriminado -> CERO líneas; todo lo demás -> EXACTAMENTE
 * una línea con alícuota de la tabla oficial. Precondición: código en el
 * catálogo y categoría válida.
 */
function lineStructureOk(category: InvoiceCategory, code: number, vatRateCodes: readonly number[]): boolean {
    if (purchaseHasNoVatBreakdown(category, code)) return vatRateCodes.length === 0;
    return vatRateCodes.length === 1 && VAT_RATES.some((r) => r.code === vatRateCodes[0]);
}

/**
 * Editable = alcance común + datos imprescindibles para reconstruir el
 * formulario + estructura de líneas coherente con el modelo manual (una fila
 * con otra estructura no puede reconstruirse sin inferir la alícuota).
 * Excepciones controladas (filas anteriores al contrato v2): condición de la
 * contraparte nula y variante nula en 001–003 -> editable, con el campo a
 * completar. Nada se infiere de la fila.
 */
export function invoiceEditability(row: EditableInvoiceRow): InvoiceEditability {
    const scope = invoiceScope(row);
    if (!scope.ok) return scope;
    const code = row.voucherCode as number;
    const insufficient = { ok: false, reason: "INSUFFICIENT_DATA" } as const;

    // Catálogo y categoría antes que la estructura de líneas (voucherType lanza fuera del catálogo).
    if (!VOUCHER_TYPES.some((v) => v.code === code) || !isCategory(row.category)) return insufficient;
    const essentials =
        row.voucherDate !== null &&
        row.counterpartyDocType !== null &&
        nonEmpty(row.counterpartyDocNumber) &&
        nonEmpty(row.counterpartyName) &&
        row.taxedNetAmount !== null &&
        row.netWithoutVatBreakdownAmount !== null &&
        lineStructureOk(row.category, code, row.vatRateCodes) &&
        (!isCodeIn(CODES_T, code) || row.turivaRelationCode !== null);
    if (!essentials) return insufficient;

    return {
        ok: true,
        requiresCounterpartyCondition: row.counterpartyVatConditionCode === null,
        requiresVoucherVariant: isCodeIn(CODES_A, code) && row.voucherVariant === null,
    };
}

// ── Acciones de la lista y estado inicial del formulario ──────────────────

/**
 * Acciones visibles en una fila de la lista: editar (ROLES_UPDATE + fila
 * editable) y eliminar (ROLES_DELETE + fila eliminable, aunque no sea
 * editable). VIEWER: ninguna. La autoridad sigue siendo la API.
 */
export function invoiceRowActions(role: Role, row: EditableInvoiceRow): { canEdit: boolean; canDelete: boolean } {
    return {
        canEdit: ROLES_UPDATE.includes(role) && invoiceEditability(row).ok,
        canDelete: ROLES_DELETE.includes(role) && invoiceDeletability(row).ok,
    };
}

const isVoucherVariant = (v: string | null): v is VoucherVariant => VOUCHER_VARIANTS.some((x) => x.code === v);

/**
 * Valores guardados en la forma del formulario (sin normalizar; el cliente
 * normaliza con la misma matriz que el alta). Precondición: fila editable
 * (invoiceEditability ya exigió la estructura de líneas del modelo).
 * Alícuota: "0" SÓLO si purchaseHasNoVatBreakdown (compra B/C, cero líneas);
 * si no, la de su única línea. Nunca se deduce de la ausencia de líneas.
 * Neto: el nominal positivo (taxed + sin discriminar), con dos decimales.
 * Condición o variante nulas quedan null (sin inferir).
 */
export function invoiceEditInitialState(row: EditableInvoiceRow): InvoiceFormState {
    const noBreakdown = isCategory(row.category) && purchaseHasNoVatBreakdown(row.category, row.voucherCode as number);
    const lineRate = row.vatRateCodes.length === 1 ? (VAT_RATES.find((r) => r.code === row.vatRateCodes[0])?.rate ?? null) : null;
    const vatRate = noBreakdown ? "0" : lineRate;
    const net = (row.taxedNetAmount as Prisma.Decimal).plus(row.netWithoutVatBreakdownAmount as Prisma.Decimal);
    return {
        selection: {
            date: isoDate(row.voucherDate),
            counterpartyCondition: row.counterpartyVatConditionCode,
            voucherCode: row.voucherCode,
            voucherVariant: isVoucherVariant(row.voucherVariant) ? row.voucherVariant : null,
            docType: row.counterpartyDocType,
            turivaRelationCode: row.turivaRelationCode,
            vatRate,
        },
        fields: {
            counterpartyName: row.counterpartyName ?? "",
            docNumber: row.counterpartyDocNumber ?? "",
            pointOfSale: String(row.pointOfSale),
            number: String(row.number),
            netAmount: net.toFixed(2),
        },
    };
}

// ── changedFields ─────────────────────────────────────────────────────────

/** Orden fijo de los campos de negocio comparables (sólo nombres, nunca valores). */
export const CHANGED_FIELDS_ORDER = [
    "voucherDate",
    "voucherCode",
    "voucherVariant",
    "pointOfSale",
    "number",
    "counterpartyVatConditionCode",
    "counterpartyDocType",
    "counterpartyDocNumber",
    "counterpartyName",
    "turivaRelationCode",
    "netAmount",
    "vatRate",
] as const;
export type ChangedField = (typeof CHANGED_FIELDS_ORDER)[number];

/**
 * Neto canónico FIRMADO: las columnas del modelo se guardan siempre positivas,
 * por eso el signo sale del código (`voucherSign`). FC -> NC del mismo importe
 * nominal invierte el signo y cuenta como cambio de `netAmount`.
 */
function signedCanonicalNet(
    voucherCode: number,
    taxedNetAmount: Prisma.Decimal,
    netWithoutVatBreakdownAmount: Prisma.Decimal,
): Prisma.Decimal {
    return taxedNetAmount.plus(netWithoutVatBreakdownAmount).times(voucherSign(voucherCode));
}

/**
 * Campos de negocio que cambian entre la fila (bloqueada) y lo que el servidor
 * normalizó para guardar. Compara SIEMPRE valores canónicos: documento
 * normalizado, nombre recortado, neto canónico firmado y código de alícuota.
 * Nunca incluye campos derivados (columnas heredadas, IVA, totales, crédito,
 * base IIBB, pestaña, clase jurídica, updatedAt, autoría).
 * Precondición: la fila es editable (voucherCode y netos no nulos).
 */
export function changedFieldsOf(
    before: EditableInvoiceRow,
    after: { input: InvoiceV2Data; resolved: ManualInvoiceData },
): ChangedField[] {
    const { model } = after.resolved;
    const beforeCode = before.voucherCode as number;
    const beforeNet = signedCanonicalNet(
        beforeCode,
        before.taxedNetAmount as Prisma.Decimal,
        before.netWithoutVatBreakdownAmount as Prisma.Decimal,
    );
    const afterNet = signedCanonicalNet(model.voucherCode, model.taxedNetAmount, model.netWithoutVatBreakdownAmount);
    const beforeRate = before.vatRateCodes[0] ?? null;
    const afterRate = model.vatLines[0]?.vatRateCode ?? null;

    const differs: Record<ChangedField, boolean> = {
        voucherDate: isoDate(before.voucherDate) !== isoDate(model.voucherDate),
        voucherCode: beforeCode !== model.voucherCode,
        voucherVariant: before.voucherVariant !== after.resolved.voucherVariant,
        pointOfSale: before.pointOfSale !== after.input.pointOfSale,
        number: before.number !== after.input.number,
        counterpartyVatConditionCode: before.counterpartyVatConditionCode !== after.resolved.counterpartyVatConditionCode,
        counterpartyDocType: before.counterpartyDocType !== model.counterpartyDocType,
        counterpartyDocNumber: before.counterpartyDocNumber !== model.counterpartyDocNumber,
        counterpartyName: before.counterpartyName !== model.counterpartyName,
        turivaRelationCode: before.turivaRelationCode !== after.resolved.turivaRelationCode,
        netAmount: !beforeNet.equals(afterNet),
        vatRate: beforeRate !== afterRate,
    };
    return CHANGED_FIELDS_ORDER.filter((f) => differs[f]);
}
