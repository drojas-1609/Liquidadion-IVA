import "server-only";
import { Prisma } from "@prisma/client";
import { voucherSign } from "./invoice-model";

/**
 * Conceptos del total que NO son neto ni IVA (exento, no gravado,
 * percepciones, impuestos internos, otros tributos), con el signo contable del
 * comprobante, para que la lista explique por qué el total difiere de
 * neto + IVA. Sólo muestra lo guardado: no recalcula ni reclasifica nada.
 * Filas heredadas (sin código): sin desglose (sus columnas no lo tienen).
 */
export const OTHER_CONCEPTS = [
    ["exemptAmount", "Exento"],
    ["nonTaxedAmount", "No gravado"],
    ["vatPerceptionAmount", "Perc. IVA"],
    ["nationalPerceptionAmount", "Perc. nacionales"],
    ["iibbPerceptionAmount", "Perc. IIBB"],
    ["municipalPerceptionAmount", "Perc. municipales"],
    ["internalTaxesAmount", "Imp. internos"],
    ["otherTaxesAmount", "Otros tributos"],
] as const;

type ConceptField = (typeof OTHER_CONCEPTS)[number][0];
export type InvoiceConceptsRow = { voucherCode: number | null } & { [K in ConceptField]: Prisma.Decimal | null };

export function otherConceptsOf(row: InvoiceConceptsRow): Array<{ label: string; signed: Prisma.Decimal }> {
    if (row.voucherCode === null) return [];
    const s = voucherSign(row.voucherCode);
    return OTHER_CONCEPTS.flatMap(([field, label]) => {
        const v = row[field];
        return v && !v.isZero() ? [{ label, signed: v.times(s) }] : [];
    });
}
