import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { voucherKey } from "./libro-iva-import/build";
import type { LidCategory } from "./libro-iva-import/format";

/**
 * Comprobantes IMPORTADOS eliminados de la aplicación (tabla
 * InvoiceImportDeletion). Al eliminar uno se registra la huella de su clave de
 * duplicidad (la misma `voucherKey` de la importación, sin guardar el documento
 * de la contraparte en claro). Una nueva importación con esa clave queda PARA
 * REVISAR —no se vuelve a cargar en silencio— salvo que el usuario marque
 * expresamente «volver a importar los eliminados» en la vista previa; al
 * confirmarlo, el registro se borra.
 *
 * Eliminar un comprobante de la aplicación NO lo anula en ARCA.
 */

export function importKeyHash(key: string): string {
    return createHash("sha256").update(`invoice-import-key|v1|${key}`).digest("hex");
}

export interface DeletedImport {
    /** AAAA-MM-DD de la eliminación. */
    deletedOn: string;
}

type Db = Pick<Prisma.TransactionClient, "invoiceImportDeletion">;

/** Huellas de los importados eliminados del cliente para esa categoría. */
export async function deletedImportHashes(db: Db, scope: { organizationId: string; clientId: string }, category: LidCategory): Promise<Map<string, DeletedImport>> {
    const rows = await db.invoiceImportDeletion.findMany({
        where: { organizationId: scope.organizationId, clientId: scope.clientId, category },
        select: { keyHash: true, deletedAt: true },
    });
    return new Map(rows.map((r) => [r.keyHash, { deletedOn: r.deletedAt.toISOString().slice(0, 10) }]));
}

/** Registra la baja de un importado (dentro de la transacción de la baja). */
export async function recordImportedInvoiceDeletion(
    tx: Db,
    args: {
        organizationId: string;
        clientId: string;
        periodId: string;
        deletedById: string;
        row: { category: string; voucherCode: number; pointOfSale: number; number: number; counterpartyDocType: number | null; counterpartyDocNumber: string | null };
    },
): Promise<void> {
    const { row } = args;
    if (row.category !== "SALES" && row.category !== "PURCHASES") throw new Error("baja de importado: categoría inválida");
    const keyHash = importKeyHash(voucherKey({
        category: row.category, voucherCode: row.voucherCode, pointOfSale: row.pointOfSale, number: row.number,
        counterpartyDocType: row.counterpartyDocType, counterpartyDocNumber: row.counterpartyDocNumber,
    }));
    await tx.invoiceImportDeletion.upsert({
        where: { organizationId_clientId_keyHash: { organizationId: args.organizationId, clientId: args.clientId, keyHash } },
        create: {
            organizationId: args.organizationId, clientId: args.clientId, category: row.category, keyHash,
            voucherCode: row.voucherCode, pointOfSale: row.pointOfSale, number: row.number, periodId: args.periodId, deletedById: args.deletedById,
        },
        update: { periodId: args.periodId, deletedAt: new Date(), deletedById: args.deletedById },
    });
}
