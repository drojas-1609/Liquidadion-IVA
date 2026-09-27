import "server-only";
import { checkVoucherCombination } from "./arca/voucher-matrix";
import { checkCounterpartyDocument } from "./arca/document-rules";
import { derivedVoucherClass, type LegalClass } from "./arca/voucher-legal-class";
import type { VoucherVariant } from "./arca/catalogs";
import { modelFromVoucher, legacyColumnsFor, type InvoiceModelData, type LegacyColumns } from "./invoice-model";
import { modelRangeError, type InvoiceV2Data } from "./api-input";

/**
 * Alta MANUAL con el contrato v2: resuelve, en este orden,
 *   1. condición fiscal del cliente (código oficial leído de la base);
 *   2. matriz normativa (`checkVoucherCombination`, autoridad normativa);
 *   3. documento de la contraparte (`checkCounterpartyDocument`, autoridad documental);
 *   4. modelo contable (`modelFromVoucher`) y columnas heredadas;
 *   5. clase jurídica y leyenda DERIVADAS (voucher-legal-class; no se almacenan).
 * La pestaña del Libro IVA Digital se deriva del código (TURIVA sólo 195–197);
 * el cuerpo de la solicitud nunca la define. La inclusión del período en el
 * Régimen TurIVA se verifica en la ruta, bajo bloqueo del Period.
 */

export interface ManualInvoiceData {
    model: InvoiceModelData;
    legacy: LegacyColumns;
    voucherVariant: VoucherVariant | null;
    turivaRelationCode: string | null;
    counterpartyVatConditionCode: number;
    legalClass: LegalClass;
    mandatoryLegend: string | null;
    /** Matriz O documento con validación parcial. */
    partialValidation: boolean;
    requiresTurivaSection: boolean;
}

export type ManualInvoiceResult =
    | { ok: true; data: ManualInvoiceData }
    | { ok: false; field: string; error: string; pending: boolean };

const fail = (field: string, error: string, pending = false): ManualInvoiceResult => ({ ok: false, field, error, pending });

/** `clientCondition`: `clientConditionCode(Client.condition)` leído con organizationId. */
export function resolveManualInvoice(input: InvoiceV2Data, clientCondition: number | null): ManualInvoiceResult {
    const { counterparty: cp } = input;

    const matrix = checkVoucherCombination({
        direction: input.category,
        clientCondition,
        counterpartyCondition: cp.vatConditionCode,
        voucherCode: input.voucherCode,
        dateIso: input.dateIso,
        voucherVariant: input.voucherVariant,
        turivaRelationCode: input.turivaRelationCode,
        counterpartyDocType: cp.docType,
    });
    if (!matrix.ok) return fail(matrix.field, matrix.error, matrix.pending);

    const doc = checkCounterpartyDocument({
        direction: input.category,
        clientCondition,
        counterpartyCondition: cp.vatConditionCode,
        voucherCode: input.voucherCode,
        docType: cp.docType,
        docNumber: cp.docNumber,
    });
    if (!doc.ok) return fail(doc.field, doc.error, doc.pending);

    const built = modelFromVoucher({
        category: input.category,
        voucherCode: input.voucherCode,
        date: input.date,
        pointOfSale: input.pointOfSale,
        number: input.number,
        counterpartyDocType: doc.docType,
        counterpartyDocNumber: doc.docNumber,
        counterpartyName: cp.name,
        netAmount: input.netAmount,
        vatRate: input.vatRate,
        lidSection: matrix.requiresTurivaSection ? "TURIVA" : "GENERAL",
    });
    if (!built.ok) return fail(built.field, built.error);
    const model = built.model;

    const range = modelRangeError(model);
    if (range) return fail(range.field, range.error);

    const derived = derivedVoucherClass(model.voucherCode, input.dateIso);
    // La matriz no admite 051–053 antes de RG 1575; defensa: nunca sin clase.
    if (derived.legalClass === null) return fail("voucherCode", "la norma no define la clase del comprobante para esa fecha");

    return {
        ok: true,
        data: {
            model,
            legacy: legacyColumnsFor(model),
            voucherVariant: input.voucherVariant,
            turivaRelationCode: input.turivaRelationCode,
            counterpartyVatConditionCode: cp.vatConditionCode,
            legalClass: derived.legalClass,
            mandatoryLegend: derived.mandatoryLegend,
            partialValidation: matrix.partialValidation || doc.partialValidation,
            requiresTurivaSection: matrix.requiresTurivaSection,
        },
    };
}
