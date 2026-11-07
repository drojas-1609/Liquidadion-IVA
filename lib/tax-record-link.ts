import "server-only";
import type { Prisma } from "@prisma/client";
import { ValidationError } from "./auth/errors";
import type { TaxDetailData } from "./api-input";

/**
 * Percepción tomada de un comprobante de compra (fuente única, sin duplicar):
 * se valida BAJO el bloqueo del Period que ya tomó el llamador. El comprobante
 * debe ser una COMPRA del MISMO período y organización, con percepción de IVA
 * informada, y el importe debe ser exactamente esa percepción. El índice único
 * parcial TaxRecord_invoice_key impide vincularlo dos veces (409).
 */
export async function assertPerceptionLink(
    tx: Pick<Prisma.TransactionClient, "invoice">,
    scope: { periodId: string; organizationId: string },
    detail: Pick<TaxDetailData, "invoiceId" | "nature">,
    amount: Prisma.Decimal,
): Promise<void> {
    if (detail.invoiceId === null) return;
    const inv = await tx.invoice.findFirst({
        where: { id: detail.invoiceId, periodId: scope.periodId, organizationId: scope.organizationId },
        select: { category: true, vatPerceptionAmount: true },
    });
    if (!inv || inv.category !== "PURCHASES") throw new ValidationError("el comprobante vinculado debe ser una compra de este período", "invoiceId");
    if (!inv.vatPerceptionAmount || inv.vatPerceptionAmount.isZero()) throw new ValidationError("el comprobante no informa percepción de IVA", "invoiceId");
    if (!inv.vatPerceptionAmount.equals(amount)) {
        throw new ValidationError(`el importe debe ser la percepción informada en el comprobante (${inv.vatPerceptionAmount.toFixed(2)})`, "amount");
    }
}

export const TAX_DETAIL_SELECT = {
    nature: true, taxCode: true, regimeCode: true, agentCuit: true, intermediaryCuit: true, voucherTypeCode: true,
    voucherNumber: true, certificateNumber: true, customsDocument: true, invoiceId: true,
} as const;

/** Detalle comparable (ausente = null). */
export function taxDetailOf(d: Partial<TaxDetailData>): TaxDetailData {
    return {
        nature: d.nature ?? null, taxCode: d.taxCode ?? null, regimeCode: d.regimeCode ?? null, agentCuit: d.agentCuit ?? null,
        intermediaryCuit: d.intermediaryCuit ?? null, voucherTypeCode: d.voucherTypeCode ?? null, voucherNumber: d.voucherNumber ?? null,
        certificateNumber: d.certificateNumber ?? null, customsDocument: d.customsDocument ?? null, invoiceId: d.invoiceId ?? null,
    };
}

export function sameTaxDetail(a: Partial<TaxDetailData>, b: Partial<TaxDetailData>): boolean {
    return JSON.stringify(taxDetailOf(a)) === JSON.stringify(taxDetailOf(b));
}
