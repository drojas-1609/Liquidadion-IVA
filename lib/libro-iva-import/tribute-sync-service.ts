import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { previewImport, type ImportScope, type ImportFiles } from "./service";
import { voucherKey } from "./build";
import { planTributeSync, syncUpdateData, TRIBUTE_FIELDS, type SyncFileRow, type SyncInvoice, type SyncItem } from "./tribute-sync";

/**
 * Lectura y escritura de la sincronización de tributos de compras con el LID
 * (lib/libro-iva-import/tribute-sync). Los modelos del archivo salen de la
 * misma vista previa de la importación (filas «ya cargadas»); las compras del
 * período se releen bajo el bloqueo del período al confirmar.
 */

/** Filas del archivo que corresponden a compras ya cargadas, con sus tributos. */
export async function tributeSyncFileRows(scope: ImportScope, files: ImportFiles): Promise<{ rows: SyncFileRow[]; fileErrors: string[]; filesSha256: string }> {
    if (files.category !== "PURCHASES") throw new Error("tribute-sync: sólo compras");
    const { preview, vouchersSha256, aliquotsSha256 } = await previewImport(scope, files);
    const rows = preview.rows.flatMap((r) => r.status === "DUPLICATE" && r.model && r.key
        ? [{ key: r.key, tributes: Object.fromEntries(TRIBUTE_FIELDS.map((f) => [f, r.model![f] ?? new Prisma.Decimal(0)])) as SyncFileRow["tributes"] }]
        : []);
    return { rows, fileErrors: preview.fileErrors, filesSha256: createHash("sha256").update(`${vouchersSha256}|${aliquotsSha256}`).digest("hex") };
}

type InvoiceReader = Pick<Prisma.TransactionClient, "invoice">;

/** Compras del período con sus tributos (clave igual a la de la importación). */
export async function periodPurchasesForSync(db: InvoiceReader, scope: ImportScope): Promise<SyncInvoice[]> {
    const rows = await db.invoice.findMany({
        where: { organizationId: scope.organizationId, periodId: scope.periodId, category: "PURCHASES", voucherCode: { not: null } },
        select: {
            id: true, voucherCode: true, pointOfSale: true, number: true, counterpartyDocType: true, counterpartyDocNumber: true, counterpartyName: true,
            vatPerceptionAmount: true, nationalPerceptionAmount: true, iibbPerceptionAmount: true, municipalPerceptionAmount: true,
            internalTaxesAmount: true, otherTaxesAmount: true, nonTaxedAmount: true, exemptAmount: true,
        },
    });
    return rows.map((r) => ({
        id: r.id, voucherCode: r.voucherCode, pointOfSale: r.pointOfSale, number: r.number,
        counterpartyDocNumber: r.counterpartyDocNumber, counterpartyName: r.counterpartyName,
        key: voucherKey({ category: "PURCHASES", voucherCode: r.voucherCode as number, pointOfSale: r.pointOfSale, number: r.number, counterpartyDocType: r.counterpartyDocType, counterpartyDocNumber: r.counterpartyDocNumber }),
        tributes: Object.fromEntries(TRIBUTE_FIELDS.map((f) => [f, r[f]])) as SyncInvoice["tributes"],
    }));
}

/** Huella de la vista previa: archivos + exclusiones + lo que se va a cambiar. */
export function tributeSyncToken(filesSha256: string, excluded: readonly string[], items: readonly SyncItem[]): string {
    return createHash("sha256").update(JSON.stringify({
        v: 1, filesSha256, excluded: [...excluded].sort(),
        items: items.map((i) => [i.invoiceId, i.applicable, i.excluded, i.changes.map((c) => [c.field, c.before.toFixed(2), c.after.toFixed(2)])]),
    })).digest("hex");
}

/** Escrituras por tramo (mismo criterio que la conciliación: la transacción vence a los 10 s). */
export const TRIBUTE_SYNC_MAX_WRITES = 8;

export async function applyTributeSync(
    tx: Pick<Prisma.TransactionClient, "invoice">,
    scope: ImportScope,
    items: readonly SyncItem[],
    profileId: string,
): Promise<{ applied: number; pending: boolean }> {
    const todo = items.filter((i) => i.applicable && !i.excluded);
    const now = todo.slice(0, TRIBUTE_SYNC_MAX_WRITES);
    for (const it of now) {
        await tx.invoice.update({
            where: { id_organizationId: { id: it.invoiceId, organizationId: scope.organizationId } },
            data: { ...syncUpdateData(it), updatedById: profileId },
        });
    }
    return { applied: now.length, pending: todo.length > now.length };
}

export { planTributeSync };
