import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Fila de Invoice BLOQUEADA (`SELECT … FOR UPDATE`) dentro de la transacción
 * de una edición o baja. Sólo las columnas que usan la reevaluación de
 * editabilidad/eliminabilidad, `changedFields` y la auditoría.
 *
 * Orden de bloqueo obligatorio: SIEMPRE `lockPeriodForWrite` (lib/period-lock)
 * ANTES que este helper. No abre transacciones: recibe el `tx` de la ruta.
 */
export interface LockedInvoiceRow {
    id: string;
    organizationId: string;
    periodId: string;
    clientId: string | null;
    category: string;
    source: string | null;
    voucherCode: number | null;
    voucherDate: Date | null;
    pointOfSale: number;
    number: number;
    counterpartyDocType: number | null;
    counterpartyDocNumber: string | null;
    counterpartyName: string | null;
    counterpartyVatConditionCode: number | null;
    voucherVariant: string | null;
    turivaRelationCode: string | null;
    taxedNetAmount: Prisma.Decimal | null;
    netWithoutVatBreakdownAmount: Prisma.Decimal | null;
    updatedAt: Date;
}

export type InvoiceLockTx = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Bloquea la fila por id y organización con un tagged template parametrizado
 * (nunca `$queryRawUnsafe` ni concatenación). null si no existe en esa
 * organización.
 */
export async function lockInvoiceForUpdate(
    tx: InvoiceLockTx,
    invoiceId: string,
    organizationId: string,
): Promise<LockedInvoiceRow | null> {
    const rows = await tx.$queryRaw<LockedInvoiceRow[]>`
        SELECT "id", "organizationId", "periodId", "clientId", "category", "source",
               "voucherCode", "voucherDate", "pointOfSale", "number",
               "counterpartyDocType", "counterpartyDocNumber", "counterpartyName",
               "counterpartyVatConditionCode", "voucherVariant", "turivaRelationCode",
               "taxedNetAmount", "netWithoutVatBreakdownAmount", "updatedAt"
        FROM "Invoice"
        WHERE "id" = ${invoiceId} AND "organizationId" = ${organizationId}
        FOR UPDATE`;
    return rows.length === 1 ? rows[0] : null;
}
