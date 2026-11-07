import "server-only";
import type { PrismaClient } from "@prisma/client";
import { voucherDisplayLabel, voucherType, isoDate } from "./invoice-model";
import { formatIsoDate, formatMoney } from "./format";

/**
 * Compras del período con percepción de IVA informada en el comprobante y sin
 * registrar como percepción (más la vinculada al registro en edición). Los datos
 * sugeridos salen del PROPIO comprobante: importe, fecha, CUIT del vendedor
 * (agente de percepción), tipo de comprobante de la tabla del F.2051 según la
 * clase del comprobante (factura 1, nota de crédito 3, nota de débito 4) y el
 * número con el formato 99999-99999999 de esa tabla. El régimen no se sugiere.
 */
export interface PerceptionSourceView {
    id: string;
    label: string;
    amount: string;
    date: string;
    agentCuit: string;
    voucherTypeCode: string;
    voucherNumber: string;
}

const F2051_TYPE_BY_KIND: Record<string, string> = { INVOICE: "1", CREDIT_NOTE: "3", DEBIT_NOTE: "4" };

export async function perceptionSources(
    db: Pick<PrismaClient, "invoice">,
    scope: { organizationId: string; periodId: string },
    includeInvoiceId: string | null = null,
): Promise<PerceptionSourceView[]> {
    const rows = await db.invoice.findMany({
        where: {
            periodId: scope.periodId,
            organizationId: scope.organizationId,
            category: "PURCHASES",
            voucherCode: { not: null },
            vatPerceptionAmount: { gt: 0 },
            OR: [{ linkedTaxRecords: { none: {} } }, ...(includeInvoiceId ? [{ id: includeInvoiceId }] : [])],
        },
        select: { id: true, voucherCode: true, pointOfSale: true, number: true, voucherDate: true, counterpartyDocType: true, counterpartyDocNumber: true, counterpartyName: true, vatPerceptionAmount: true },
        orderBy: [{ voucherDate: "asc" }, { number: "asc" }],
        take: 500,
    });
    return rows.map((r) => {
        const kind = voucherType(r.voucherCode!).kind;
        const nro = `${String(r.pointOfSale).padStart(5, "0")}-${String(r.number).padStart(8, "0")}`;
        const amount = r.vatPerceptionAmount!.toFixed(2);
        const date = isoDate(r.voucherDate) ?? "";
        return {
            id: r.id,
            label: `${formatIsoDate(date)} · ${voucherDisplayLabel(r.voucherCode!)} ${nro} · ${r.counterpartyName ?? ""} · percepción $${formatMoney(amount)}`,
            amount,
            date,
            agentCuit: r.counterpartyDocType === 80 ? (r.counterpartyDocNumber ?? "") : "",
            voucherTypeCode: F2051_TYPE_BY_KIND[kind] ?? "",
            voucherNumber: nro,
        };
    });
}
