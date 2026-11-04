import "server-only";
import type { PrismaClient } from "@prisma/client";
import { pageWindow, type PageWindow } from "./pagination";

/**
 * Detalle paginado de comprobantes de un período (ventas o compras). Filtra por
 * período y organización, ya autorizados por requirePeriodAccess con el cliente
 * esperado. Orden estable: fecha descendente y, a igual fecha, id: una página
 * no repite ni saltea filas entre recargas si no hay altas o bajas.
 * Los totales del período NO salen de acá (lib/liquidation-totals).
 */
export async function listPeriodInvoices(
    db: Pick<PrismaClient, "invoice">,
    scope: { organizationId: string; periodId: string },
    category: "SALES" | "PURCHASES",
    requestedPage: number,
) {
    const where = { periodId: scope.periodId, organizationId: scope.organizationId, category };
    const total = await db.invoice.count({ where });
    const window: PageWindow = pageWindow(requestedPage, total);
    const invoices = await db.invoice.findMany({
        where,
        orderBy: [{ date: "desc" }, { id: "desc" }],
        skip: window.skip,
        take: window.pageSize,
        // Sólo los códigos de alícuota: deciden editabilidad / eliminabilidad.
        include: { vatLines: { select: { vatRateCode: true } } },
    });
    return { invoices, window };
}
