import {
    VAT_CONDITIONS,
    VOUCHER_TYPES,
    VOUCHER_VARIANTS,
    DOCUMENT_TYPES,
    TURIVA_RELATIONS,
    VAT_RATES,
    RULE_PURCHASES_BC_NO_VAT_LINES,
    type VoucherVariant,
} from "./arca/catalogs";
import {
    CODES_T,
    TURIVA_PARTIAL_VALIDATION_MESSAGE,
    allowedVoucherCodes,
    allowedVoucherVariants,
    checkVoucherCombination,
    type Direction,
} from "./arca/voucher-matrix";
import { allowedDocTypes, allowedDocumentRule, pendingDocumentRules } from "./arca/document-rules";
import { derivedVoucherClass, type LegalClass } from "./arca/voucher-legal-class";
import { checkVoucherDate } from "./invoice-rules";
import { periodFirstDayIso, periodLastDayIso } from "./period";

/**
 * Opciones del formulario de alta manual (contrato v2) a partir de la matriz
 * normativa y las reglas documentales.
 *
 * SÓLO FILTRA: toda decisión se delega en las funciones existentes
 * (allowedVoucherCodes, allowedVoucherVariants, checkVoucherCombination,
 * allowedDocTypes, allowedDocumentRule, pendingDocumentRules,
 * checkVoucherDate, derivedVoucherClass). No hay reglas propias; los avisos
 * sólo explican resultados de esas funciones. La autoridad es la API
 * (POST /api/invoices). El número de documento NO interviene: su validación
 * (checkCounterpartyDocument) ocurre en la API con el número real.
 *
 * Orden de selección: fecha -> condición de la contraparte -> comprobante ->
 * documento -> variante (001–003) / relación TurIVA (195–197) -> alícuota.
 * Cada paso depende de los anteriores; la normalización descarta toda
 * elección que ya no figure entre las opciones. Es determinista e idempotente.
 * Única preselección: la variante, cuando hay exactamente una válida.
 *
 * Lógica pura, sin `server-only`, Prisma ni Decimal: apta para el cliente.
 */

export interface InvoiceFormContext {
    direction: Direction;
    /** `clientConditionCode(Client.condition)`, resuelto en el servidor. */
    clientConditionCode: number | null;
    /** `PeriodVatSettings.turivaIncluded`, resuelto en el servidor. */
    turivaIncluded: boolean;
    period: { month: number; year: number };
}

export interface InvoiceFormSelection {
    /** `AAAA-MM-DD`. */
    date: string | null;
    counterpartyCondition: number | null;
    voucherCode: number | null;
    voucherVariant: VoucherVariant | null;
    docType: number | null;
    turivaRelationCode: string | null;
    vatRate: string | null;
}

export const EMPTY_SELECTION: InvoiceFormSelection = {
    date: null,
    counterpartyCondition: null,
    voucherCode: null,
    voucherVariant: null,
    docType: null,
    turivaRelationCode: null,
    vatRate: null,
};

export interface Option<T> {
    value: T;
    label: string;
}

export type FormNoticeCode =
    | "CLIENT_CONDITION_UNSUPPORTED"
    | "DATE_INVALID"
    | "PURCHASE_PRIOR_PERIOD"
    | "NO_ALLOWED_COMBINATION"
    | "TURIVA_NOT_INCLUDED"
    | "VOUCHER_PENDING"
    | "DOCUMENT_PENDING"
    | "PARTIAL_VALIDATION";

export interface FormNotice {
    code: FormNoticeCode;
    /** blocking: no hay forma de completar el alta con las elecciones actuales. */
    level: "info" | "warning" | "blocking";
    message: string;
}

export interface DerivedPreview {
    legalClass: LegalClass | null;
    mandatoryLegend: string | null;
    partialValidation: boolean;
    requiresTurivaSection: boolean;
}

export interface InvoiceFormOptions {
    dateBounds: { min: string | null; max: string };
    counterpartyConditions: Option<number>[];
    voucherCodes: Option<number>[];
    variants: Option<VoucherVariant>[];
    docTypes: Option<number>[];
    turivaRelations: Option<string>[];
    vatRates: Option<string>[];
    selection: InvoiceFormSelection;
    /** null hasta que estén completas las selecciones necesarias. */
    derived: DerivedPreview | null;
    notices: FormNotice[];
}

// ── Etiquetas (siempre de los catálogos) ─────────────────────────────────

const pad3 = (n: number) => String(n).padStart(3, "0");
const voucherLabel = (code: number) => `${pad3(code)} – ${VOUCHER_TYPES.find((v) => v.code === code)?.label ?? ""}`;
const conditionOption = (code: number): Option<number> => ({
    value: code,
    label: VAT_CONDITIONS.find((c) => c.code === code)?.label ?? String(code),
});
const docOption = (code: number): Option<number> => ({
    value: code,
    label: `${code} – ${DOCUMENT_TYPES.find((d) => d.code === code)?.label ?? ""}`,
});

const isTurivaCode = (code: number) => (CODES_T as readonly number[]).includes(code);
const letterOf = (code: number) => VOUCHER_TYPES.find((v) => v.code === code)?.letter ?? null;

/** `AAAA-MM-DD` existente en el calendario (mismo criterio que la API). */
function parseIsoDay(v: string | null): Date | null {
    if (v === null || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? d : null;
}

function voucherCodesFor(ctx: InvoiceFormContext, counterpartyCondition: number, dateIso: string): number[] {
    const codes = allowedVoucherCodes(ctx.direction, ctx.clientConditionCode, counterpartyCondition, dateIso);
    return ctx.turivaIncluded ? codes : codes.filter((c) => !isTurivaCode(c));
}

function matrixCheck(
    ctx: InvoiceFormContext,
    s: { counterpartyCondition: number; voucherCode: number; dateIso: string },
    extra: { voucherVariant: VoucherVariant | null; turivaRelationCode: string | null; counterpartyDocType: number | null },
) {
    return checkVoucherCombination({
        direction: ctx.direction,
        clientCondition: ctx.clientConditionCode,
        counterpartyCondition: s.counterpartyCondition,
        voucherCode: s.voucherCode,
        dateIso: s.dateIso,
        ...extra,
    });
}

/**
 * Calcula las opciones de cada selector y la selección normalizada.
 * Determinista e idempotente: resolver dos veces da el mismo resultado.
 */
export function resolveInvoiceFormOptions(ctx: InvoiceFormContext, input: InvoiceFormSelection): InvoiceFormOptions {
    const out: InvoiceFormOptions = {
        dateBounds: {
            min: ctx.direction === "SALES" ? periodFirstDayIso(ctx.period) : null,
            max: periodLastDayIso(ctx.period),
        },
        counterpartyConditions: [],
        voucherCodes: [],
        variants: [],
        docTypes: [],
        turivaRelations: [],
        vatRates: [],
        selection: { ...EMPTY_SELECTION, date: input.date },
        derived: null,
        notices: [],
    };
    const sel = out.selection;
    const notices = out.notices;

    if (ctx.clientConditionCode === null) {
        // Mensaje de la propia matriz para una condición no admitida.
        const r = checkVoucherCombination({
            direction: ctx.direction,
            clientCondition: null,
            counterpartyCondition: null,
            voucherCode: 0,
            dateIso: "",
            voucherVariant: null,
            turivaRelationCode: null,
            counterpartyDocType: null,
        });
        notices.push({ code: "CLIENT_CONDITION_UNSUPPORTED", level: "blocking", message: r.ok ? "" : r.error });
        return out;
    }

    // 1. Fecha
    const date = parseIsoDay(input.date);
    if (date === null) {
        if (input.date !== null) {
            notices.push({ code: "DATE_INVALID", level: "blocking", message: "fecha inválida: debe ser AAAA-MM-DD y existir en el calendario" });
        }
        return out;
    }
    const dateCheck = checkVoucherDate(ctx.direction, date, ctx.period);
    if (!dateCheck.ok) {
        notices.push({ code: "DATE_INVALID", level: "blocking", message: dateCheck.error });
        return out;
    }
    for (const w of dateCheck.warnings) notices.push({ code: w.code, level: "warning", message: w.message });
    const dateIso = input.date as string;

    // 2. Condición de la contraparte: sólo las que admiten algún comprobante.
    out.counterpartyConditions = VAT_CONDITIONS.filter((c) => voucherCodesFor(ctx, c.code, dateIso).length > 0).map((c) =>
        conditionOption(c.code),
    );
    if (out.counterpartyConditions.length === 0) {
        notices.push({ code: "NO_ALLOWED_COMBINATION", level: "blocking", message: "No hay comprobantes habilitados por la matriz normativa para esta fecha." });
        return out;
    }
    const cp = out.counterpartyConditions.some((o) => o.value === input.counterpartyCondition) ? input.counterpartyCondition : null;
    sel.counterpartyCondition = cp;
    if (cp === null) return out;

    // 3. Comprobante
    const codes = voucherCodesFor(ctx, cp, dateIso);
    out.voucherCodes = codes.map((c) => ({ value: c, label: voucherLabel(c) }));
    const withoutFilter = allowedVoucherCodes(ctx.direction, ctx.clientConditionCode, cp, dateIso);
    if (!ctx.turivaIncluded && withoutFilter.some(isTurivaCode)) {
        notices.push({
            code: "TURIVA_NOT_INCLUDED",
            level: "info",
            message: "El período no está incluido en el Régimen TurIVA: los comprobantes 195, 196 y 197 no se ofrecen.",
        });
    }
    const pendingCodes: number[] = [];
    let pendingMessage = "";
    for (const vt of VOUCHER_TYPES) {
        if (withoutFilter.includes(vt.code)) continue;
        const r = matrixCheck(
            ctx,
            { counterpartyCondition: cp, voucherCode: vt.code, dateIso },
            { voucherVariant: letterOf(vt.code) === "A" ? "NONE" : null, turivaRelationCode: null, counterpartyDocType: null },
        );
        if (!r.ok && r.pending) {
            pendingCodes.push(vt.code);
            pendingMessage = r.error;
        }
    }
    if (pendingCodes.length > 0) {
        notices.push({ code: "VOUCHER_PENDING", level: "info", message: `${pendingMessage}: ${pendingCodes.map(voucherLabel).join(", ")}` });
    }
    const code = codes.includes(input.voucherCode as number) ? input.voucherCode : null;
    sel.voucherCode = code;
    if (code === null) return out;

    // 4. Documento
    const docTypes = allowedDocTypes(ctx.direction, ctx.clientConditionCode, cp, code);
    out.docTypes = docTypes.map(docOption);
    // Filas PENDING: se explican con sus documentos o, si la fila no tiene
    // código de documento (p. ej. clave fiscal extranjera), con su fundamento.
    const pendingRules = pendingDocumentRules(ctx.direction, ctx.clientConditionCode, cp, code);
    if (pendingRules.length > 0) {
        const detail = pendingRules
            .map((r) => (r.docTypes.length > 0 ? r.docTypes.map((d) => docOption(d).label).join(", ") : r.basis))
            .join("; ");
        notices.push({ code: "DOCUMENT_PENDING", level: "info", message: `Pendiente de confirmación normativa (no habilitado): ${detail}` });
    }
    if (docTypes.length === 0) {
        notices.push({ code: "NO_ALLOWED_COMBINATION", level: "blocking", message: "No hay documentos habilitados para este comprobante y esta contraparte." });
    }
    sel.docType = docTypes.includes(input.docType as number) ? input.docType : null;

    // 5a. Variante (001–003). Preselección sólo si hay exactamente una.
    const variants = allowedVoucherVariants(ctx.direction, ctx.clientConditionCode, cp, code, dateIso);
    out.variants = VOUCHER_VARIANTS.filter((v) => variants.includes(v.code)).map((v) => ({ value: v.code, label: v.label }));
    sel.voucherVariant =
        variants.length === 1 ? variants[0] : variants.includes(input.voucherVariant as VoucherVariant) ? input.voucherVariant : null;

    // 5b. Relación TurIVA (195–197): la que la matriz no rechaza por relación.
    if (isTurivaCode(code)) {
        out.turivaRelations = TURIVA_RELATIONS.filter((rel) => {
            const r = matrixCheck(
                ctx,
                { counterpartyCondition: cp, voucherCode: code, dateIso },
                { voucherVariant: null, turivaRelationCode: rel.code, counterpartyDocType: null },
            );
            // Sin documento elegido la matriz puede fallar DESPUÉS de aceptar la relación.
            return r.ok || r.field === "counterpartyDocType";
        }).map((rel) => ({ value: rel.code, label: `${rel.code} – ${rel.label}` }));
    }
    sel.turivaRelationCode = out.turivaRelations.some((o) => o.value === input.turivaRelationCode) ? input.turivaRelationCode : null;

    // 6. Alícuota: compras B/C sin IVA discriminado -> sólo 0.
    const noBreakdown =
        ctx.direction === "PURCHASES" && (RULE_PURCHASES_BC_NO_VAT_LINES.letters as readonly string[]).includes(letterOf(code) ?? "");
    out.vatRates = VAT_RATES.filter((r) => !noBreakdown || r.rate === "0").map((r) => ({ value: r.rate, label: `${r.rate} %` }));
    sel.vatRate = out.vatRates.some((o) => o.value === input.vatRate) ? input.vatRate : null;

    // Derivados: sólo con las selecciones necesarias completas.
    const needsVariant = variants.length > 0;
    const needsRelation = isTurivaCode(code);
    if (sel.docType === null || (needsVariant && sel.voucherVariant === null) || (needsRelation && sel.turivaRelationCode === null)) {
        return out;
    }
    const matrix = matrixCheck(
        ctx,
        { counterpartyCondition: cp, voucherCode: code, dateIso },
        { voucherVariant: sel.voucherVariant, turivaRelationCode: sel.turivaRelationCode, counterpartyDocType: sel.docType },
    );
    // Metadata de la fila documental: el número real se valida en la API.
    const docRule = allowedDocumentRule(ctx.direction, ctx.clientConditionCode, cp, code, sel.docType);
    if (!matrix.ok || docRule === null) return out;
    const legal = derivedVoucherClass(code, dateIso);
    out.derived = {
        legalClass: legal.legalClass,
        mandatoryLegend: legal.mandatoryLegend,
        partialValidation: matrix.partialValidation || docRule.partialValidation,
        requiresTurivaSection: matrix.requiresTurivaSection,
    };
    if (out.derived.partialValidation) {
        const message = matrix.partialValidation ? TURIVA_PARTIAL_VALIDATION_MESSAGE : `Validación parcial del documento: ${docRule.basis}`;
        notices.push({ code: "PARTIAL_VALIDATION", level: "info", message });
    }
    return out;
}
