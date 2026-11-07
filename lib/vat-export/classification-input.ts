/**
 * Entrada de la edición por lote de clasificaciones (PATCH
 * /api/periods/[id]/invoice-classification). Lógica pura, sin `server-only`:
 * la usa también el formulario.
 *
 * Sólo se cambian las claves PRESENTES en `changes`. `null` borra la
 * clasificación (vuelve a pendiente). Nada se completa por defecto.
 */

export const CLASSIFICATION_BATCH_MAX = 500;

export const SALE_OPERATION_TYPES = ["GOODS_SERVICES", "CAPITAL_GOODS"] as const;
export const BUYER_TYPES = ["RESPONSABLE_INSCRIPTO", "MONOTRIBUTO", "CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO"] as const;
export const PURCHASE_CREDIT_CONCEPTS = ["GOODS", "LEASES", "SERVICES", "CAPITAL_GOODS"] as const;
/** Códigos de operación de la tabla oficial (sin "0" = no corresponde). */
export const CLASSIFIABLE_OPERATION_CODES = ["A", "C", "D", "E", "N", "T", "X", "Z"] as const;

export const SALE_OPERATION_TYPE_LABELS: Record<(typeof SALE_OPERATION_TYPES)[number], string> = {
    GOODS_SERVICES: "1 · Cosas muebles, obras, locaciones y servicios",
    CAPITAL_GOODS: "2 · Bienes de uso",
};
export const BUYER_TYPE_LABELS: Record<(typeof BUYER_TYPES)[number], string> = {
    RESPONSABLE_INSCRIPTO: "1 · Responsables inscriptos",
    MONOTRIBUTO: "2 · Monotributistas",
    CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO: "3 · Consumidores finales, exentos y no alcanzados",
};
export const PURCHASE_CREDIT_CONCEPT_LABELS: Record<(typeof PURCHASE_CREDIT_CONCEPTS)[number], string> = {
    GOODS: "1 · Compras de bienes (excepto bienes de uso)",
    LEASES: "2 · Locaciones",
    SERVICES: "3 · Prestaciones de servicios",
    CAPITAL_GOODS: "4 · Inversiones de bienes de uso",
};

export interface ClassificationChanges {
    activityCode?: string | null;
    saleOperationType?: (typeof SALE_OPERATION_TYPES)[number] | null;
    buyerType?: (typeof BUYER_TYPES)[number] | null;
    purchaseCreditConcept?: (typeof PURCHASE_CREDIT_CONCEPTS)[number] | null;
    operationCode?: (typeof CLASSIFIABLE_OPERATION_CODES)[number] | null;
    dationInPayment?: boolean;
}

export const SALES_ONLY_FIELDS = ["activityCode", "saleOperationType", "buyerType", "dationInPayment"] as const;
export const PURCHASES_ONLY_FIELDS = ["purchaseCreditConcept"] as const;

export type ClassificationInput = { invoiceIds: string[]; changes: ClassificationChanges; changedFields: string[] };
type Result = { ok: true; data: ClassificationInput } | { ok: false; field: string; error: string };

const ID_RE = /^[a-z0-9]{20,40}$/;

function oneOf<T extends string>(v: unknown, list: readonly T[]): v is T {
    return typeof v === "string" && (list as readonly string[]).includes(v);
}

export function parseClassificationInput(body: unknown): Result {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, field: "body", error: "cuerpo inválido" };
    const b = body as Record<string, unknown>;
    const ids = b.invoiceIds;
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, field: "invoiceIds", error: "elegí al menos un comprobante" };
    if (ids.length > CLASSIFICATION_BATCH_MAX) return { ok: false, field: "invoiceIds", error: `hasta ${CLASSIFICATION_BATCH_MAX} comprobantes por vez` };
    if (!ids.every((x) => typeof x === "string" && ID_RE.test(x))) return { ok: false, field: "invoiceIds", error: "identificador de comprobante inválido" };
    if (new Set(ids).size !== ids.length) return { ok: false, field: "invoiceIds", error: "comprobante repetido en la selección" };
    const c = b.changes;
    if (typeof c !== "object" || c === null || Array.isArray(c)) return { ok: false, field: "changes", error: "indicá qué clasificar" };
    const src = c as Record<string, unknown>;
    const changes: ClassificationChanges = {};
    const allowed = ["activityCode", "saleOperationType", "buyerType", "purchaseCreditConcept", "operationCode", "dationInPayment"];
    for (const k of Object.keys(src)) if (!allowed.includes(k)) return { ok: false, field: k, error: "campo no admitido" };
    if ("activityCode" in src) {
        const v = src.activityCode;
        if (v !== null && (typeof v !== "string" || !/^\d{6}$/.test(v))) return { ok: false, field: "activityCode", error: "la actividad es el código ARCA de 6 dígitos" };
        changes.activityCode = v as string | null;
    }
    if ("saleOperationType" in src) {
        const v = src.saleOperationType;
        if (v !== null && !oneOf(v, SALE_OPERATION_TYPES)) return { ok: false, field: "saleOperationType", error: "tipo de operación inválido" };
        changes.saleOperationType = v as ClassificationChanges["saleOperationType"];
    }
    if ("buyerType" in src) {
        const v = src.buyerType;
        if (v !== null && !oneOf(v, BUYER_TYPES)) return { ok: false, field: "buyerType", error: "tipo de sujeto comprador inválido" };
        changes.buyerType = v as ClassificationChanges["buyerType"];
    }
    if ("purchaseCreditConcept" in src) {
        const v = src.purchaseCreditConcept;
        if (v !== null && !oneOf(v, PURCHASE_CREDIT_CONCEPTS)) return { ok: false, field: "purchaseCreditConcept", error: "concepto del crédito inválido" };
        changes.purchaseCreditConcept = v as ClassificationChanges["purchaseCreditConcept"];
    }
    if ("operationCode" in src) {
        const v = src.operationCode;
        if (v !== null && !oneOf(v, CLASSIFIABLE_OPERATION_CODES)) return { ok: false, field: "operationCode", error: "código de operación fuera de la tabla oficial" };
        changes.operationCode = v as ClassificationChanges["operationCode"];
    }
    if ("dationInPayment" in src) {
        if (typeof src.dationInPayment !== "boolean") return { ok: false, field: "dationInPayment", error: "dación en pago: sí o no" };
        changes.dationInPayment = src.dationInPayment;
    }
    const changedFields = Object.keys(changes).sort();
    if (changedFields.length === 0) return { ok: false, field: "changes", error: "indicá qué clasificar" };
    return { ok: true, data: { invoiceIds: ids as string[], changes, changedFields } };
}
