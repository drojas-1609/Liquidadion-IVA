import { Prisma } from "@prisma/client";

/**
 * Sincronización de tributos de compras YA cargadas con el Libro IVA Digital.
 *
 * Portal IVA informa «Otros tributos» en un solo importe y la separación por
 * regla de proveedor puede no coincidir con lo que el estudio declaró. El LID
 * presentado discrimina percepciones de IVA, nacionales, de IIBB, municipales,
 * impuestos internos, no gravado y exento. Esta función compara comprobante por
 * comprobante (misma clave) y propone llevar esos campos a lo del LID.
 *
 * Reglas (función pura):
 *  - Sólo se mueven importes entre esos 8 campos: la suma tiene que ser
 *    EXACTAMENTE la misma (el total del comprobante no cambia); si no, la fila
 *    queda informada como «no aplicable» con el motivo.
 *  - Neto gravado, IVA y crédito computable no se tocan.
 *  - Un proveedor excluido por el estudio no se modifica.
 */

export const TRIBUTE_FIELDS = [
    "vatPerceptionAmount", "nationalPerceptionAmount", "iibbPerceptionAmount", "municipalPerceptionAmount",
    "internalTaxesAmount", "otherTaxesAmount", "nonTaxedAmount", "exemptAmount",
] as const;
export type TributeField = (typeof TRIBUTE_FIELDS)[number];
export type Tributes = Record<TributeField, Prisma.Decimal>;

export const TRIBUTE_LABELS: Record<TributeField, string> = {
    vatPerceptionAmount: "Percepción de IVA",
    nationalPerceptionAmount: "Otras percepciones nacionales",
    iibbPerceptionAmount: "Percepción de IIBB",
    municipalPerceptionAmount: "Percepciones municipales",
    internalTaxesAmount: "Impuestos internos",
    otherTaxesAmount: "Otros tributos",
    nonTaxedAmount: "No gravado",
    exemptAmount: "Exento",
};

export interface SyncFileRow { key: string; tributes: Tributes }
export interface SyncInvoice {
    id: string;
    key: string;
    counterpartyDocNumber: string | null;
    counterpartyName: string | null;
    pointOfSale: number;
    number: number;
    voucherCode: number | null;
    tributes: Record<TributeField, Prisma.Decimal | null>;
}

export interface SyncItem {
    invoiceId: string;
    supplierCuit: string | null;
    supplierName: string | null;
    voucher: string;
    changes: { field: TributeField; before: Prisma.Decimal; after: Prisma.Decimal }[];
    applicable: boolean;
    reason: string | null;
    excluded: boolean;
}

const Z = new Prisma.Decimal(0);
const sumOf = (t: Record<TributeField, Prisma.Decimal | null>) => TRIBUTE_FIELDS.reduce((s, f) => s.plus(t[f] ?? Z), Z);

export function planTributeSync(file: readonly SyncFileRow[], invoices: readonly SyncInvoice[], excludedCuits: ReadonlySet<string>): SyncItem[] {
    const byKey = new Map(file.map((r) => [r.key, r]));
    const out: SyncItem[] = [];
    for (const inv of invoices) {
        const f = byKey.get(inv.key);
        if (!f) continue;
        const changes = TRIBUTE_FIELDS.flatMap((field) => {
            const before = inv.tributes[field] ?? Z;
            const after = f.tributes[field];
            return before.equals(after) ? [] : [{ field, before, after }];
        });
        if (changes.length === 0) continue;
        const same = sumOf(inv.tributes).equals(sumOf(f.tributes));
        out.push({
            invoiceId: inv.id,
            supplierCuit: inv.counterpartyDocNumber,
            supplierName: inv.counterpartyName,
            voucher: `${String(inv.pointOfSale).padStart(4, "0")}-${String(inv.number).padStart(8, "0")}`,
            changes,
            applicable: same,
            reason: same ? null : `la suma de tributos difiere en ${sumOf(f.tributes).minus(sumOf(inv.tributes)).toFixed(2)} (el total del comprobante no coincide con el Libro IVA): revisalo a mano`,
            excluded: inv.counterpartyDocNumber !== null && excludedCuits.has(inv.counterpartyDocNumber),
        });
    }
    return out.sort((a, b) => (a.supplierName ?? "").localeCompare(b.supplierName ?? "") || a.voucher.localeCompare(b.voucher));
}

/** Datos a escribir para un ítem aplicable (los 8 campos, con lo del archivo). */
export function syncUpdateData(item: SyncItem): Partial<Record<TributeField, Prisma.Decimal>> {
    return Object.fromEntries(item.changes.map((c) => [c.field, c.after]));
}
