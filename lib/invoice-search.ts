import { Prisma } from "@prisma/client";

/**
 * Búsqueda en el detalle de ventas o compras de un período. Un único texto se
 * interpreta según su forma, y las alternativas se combinan con O:
 *  - razón social: contiene el texto (sin distinguir mayúsculas);
 *  - CUIT o documento: contiene los dígitos (3 o más);
 *  - comprobante «PV-número» (p. ej. 7-13442, 00007-00013442): ese punto de
 *    venta y número; sólo dígitos (hasta 8): ese número, en cualquier PV;
 *  - importe (p. ej. 909.799,99 · 909799,99 · 909799.99): ese total.
 * Texto vacío o de menos de 2 caracteres: sin filtro.
 */
export const SEARCH_MAX_LENGTH = 60;

export function normalizeSearch(raw: string | string[] | undefined): string {
    const v = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    return v.trim().replace(/\s+/g, " ").slice(0, SEARCH_MAX_LENGTH);
}

/** Importe en formato argentino (miles con punto, decimales con coma) o con punto decimal. */
export function parseSearchAmount(text: string): Prisma.Decimal | null {
    const t = text.replace(/^\$\s*/, "");
    let canonical: string | null = null;
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) canonical = t.replace(/\./g, "").replace(",", ".");
    else if (/^\d+,\d{1,2}$/.test(t)) canonical = t.replace(",", ".");
    else if (/^\d+\.\d{1,2}$/.test(t)) canonical = t;
    return canonical === null ? null : new Prisma.Decimal(canonical);
}

export function invoiceSearchWhere(text: string): Prisma.InvoiceWhereInput | null {
    if (text.length < 2) return null;
    const or: Prisma.InvoiceWhereInput[] = [{ counterpartyName: { contains: text, mode: "insensitive" } }];
    const voucher = /^(\d{1,5})\s*-\s*(\d{1,8})$/.exec(text);
    if (voucher) {
        or.push({ pointOfSale: Number(voucher[1]), number: Number(voucher[2]) });
    }
    const digits = text.replace(/[-.\s]/g, "");
    if (/^\d+$/.test(digits)) {
        if (digits.length >= 3) or.push({ counterpartyDocNumber: { contains: digits } });
        if (!voucher && /^\d{1,8}$/.test(text)) or.push({ number: Number(text) });
    }
    const amount = parseSearchAmount(text);
    if (amount !== null) or.push({ totalAmount: { in: [amount, amount.negated()] } });
    return { OR: or };
}
