import "server-only";
import type { Prisma } from "@prisma/client";
import { ConflictError, NotFoundError } from "./auth/errors";
import { lockClientForUpdate } from "./client-lock";

/**
 * Rangos de VENTAS (venta global diaria, documento 99): un comprobante no puede
 * caer dentro de un rango ya cargado ni un rango contener comprobantes ya
 * cargados, con el mismo tipo y punto de venta, en todos los períodos del
 * cliente. La coincidencia exacta del primer número la cubre el índice único
 * Invoice_sales_voucher_key; la superposición no tiene índice, así que bajo
 * concurrencia la garantiza el bloqueo de la fila Client (después del Period),
 * que serializa las altas y ediciones de ventas del cliente.
 */
export interface SalesRangeQuery {
    organizationId: string;
    clientId: string;
    voucherCode: number;
    pointOfSale: number;
    from: number;
    to: number;
    excludeInvoiceId?: string;
}

type Db = Pick<Prisma.TransactionClient, "invoice">;

export async function findSalesRangeOverlap(db: Db, q: SalesRangeQuery) {
    return db.invoice.findFirst({
        where: {
            organizationId: q.organizationId, clientId: q.clientId, category: "SALES", voucherCode: q.voucherCode, pointOfSale: q.pointOfSale,
            NOT: [{ number: q.from }, ...(q.excludeInvoiceId ? [{ id: q.excludeInvoiceId }] : [])],
            OR: [
                { numberTo: null, number: { gte: q.from, lte: q.to } },
                { numberTo: { gte: q.from }, number: { lte: q.to } },
            ],
        },
        select: { number: true, numberTo: true, period: { select: { month: true, year: true } } },
    });
}

export function salesRangeOverlapMessage(o: { number: number; numberTo: number | null; period: { month: number; year: number } }): string {
    const what = o.numberTo !== null && o.numberTo !== o.number ? `el rango ${o.number}–${o.numberTo}` : `el comprobante ${o.number}`;
    return `Se superpone con ${what} del período ${String(o.period.month).padStart(2, "0")}/${o.period.year} (mismo tipo y punto de venta).`;
}

/** Dentro de la transacción, después de lockPeriodForWrite: bloqueo del cliente y relectura (409 si se superpone). */
export async function assertNoSalesRangeOverlapUnderLock(tx: Db & Pick<Prisma.TransactionClient, "$queryRaw">, q: SalesRangeQuery): Promise<void> {
    if (!(await lockClientForUpdate(tx, q.clientId, q.organizationId))) throw new NotFoundError();
    const overlap = await findSalesRangeOverlap(tx, q);
    if (overlap) throw new ConflictError(salesRangeOverlapMessage(overlap));
}
