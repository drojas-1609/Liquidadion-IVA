import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { raise, type ImportRowStatus } from "../tax-import/common";
import { IIBB_IMPORT_FORMATS, parseIibbDeductions, type IibbImportFormat, type IibbImportRow } from "./formats";

/**
 * Vista previa de la importación de deducciones de IIBB informadas por el fisco
 * (lib/iibb-import/formats). Función pura sobre lo ya leído: la confirmación la
 * vuelve a ejecutar BAJO el bloqueo del período y del cliente.
 *  - fecha fuera del mes del período -> REVISAR (se carga a mano si corresponde);
 *  - repetida dentro del archivo -> ERROR;
 *  - ya registrada para el cliente (cualquier período, misma jurisdicción e
 *    identidad; también si vino en el otro formato del mismo fisco) -> YA
 *    REGISTRADA; con otro importe -> REVISAR.
 */

export interface IibbImportPreview {
    format: IibbImportFormat | null;
    formatLabel: string | null;
    jurisdictionCode: string | null;
    rows: IibbImportRow[];
    fileErrors: string[];
    counts: Record<ImportRowStatus, number>;
    importableTotal: string;
    excludedTotal: string;
    fileSha256: string;
    token: string;
}

export interface RegisteredIibbDeduction {
    amount: Prisma.Decimal;
    period: string;
}

type Db = Pick<PrismaClient, "taxRecord"> | Prisma.TransactionClient;

const key = (jurisdictionCode: string, identity: string) => `${jurisdictionCode}|${identity}`;

/** Deducciones importadas ya registradas para el cliente, en cualquiera de sus períodos. */
export async function registeredIibbDeductions(db: Db, scope: { organizationId: string; clientId: string }): Promise<Map<string, RegisteredIibbDeduction>> {
    const rows = await db.taxRecord.findMany({
        where: { organizationId: scope.organizationId, importIdentity: { not: null }, period: { clientId: scope.clientId } },
        select: { jurisdictionCode: true, importIdentity: true, amount: true, period: { select: { month: true, year: true } } },
    });
    const out = new Map<string, RegisteredIibbDeduction>();
    for (const r of rows) {
        if (!r.jurisdictionCode || !r.importIdentity) continue;
        out.set(key(r.jurisdictionCode, r.importIdentity), {
            amount: new Prisma.Decimal(r.amount),
            period: `${String(r.period.month).padStart(2, "0")}/${r.period.year}`,
        });
    }
    return out;
}

export function buildIibbImportPreview(
    file: Uint8Array,
    period: { month: number; year: number },
    existing: ReadonlyMap<string, RegisteredIibbDeduction>,
    periodId: string,
): IibbImportPreview {
    const parsed = parseIibbDeductions(file);
    const ym = `${period.year}-${String(period.month).padStart(2, "0")}`;
    const seen = new Set<string>();
    for (const r of parsed.rows) {
        if (r.status === "ERROR") continue;
        if (!r.date || r.date.slice(0, 7) !== ym) raise(r, "REVIEW", `fecha fuera del período ${String(period.month).padStart(2, "0")}/${period.year}: si corresponde computarla acá, cargala a mano`);
        if (!r.identity) { raise(r, "ERROR", "faltan datos para identificar la deducción"); continue; }
        const k = key(r.jurisdictionCode, r.identity);
        if (seen.has(k)) { raise(r, "ERROR", "repetida en el archivo"); continue; }
        seen.add(k);
        const at = existing.get(k);
        if (at && (r.status as ImportRowStatus) !== "ERROR") {
            if (r.amount && r.amount.equals(at.amount)) {
                r.messages.unshift(`ya registrada para el cliente en el período ${at.period}: se omite`);
                r.status = "DUPLICATE";
            } else {
                raise(r, "REVIEW", `ya registrada en el período ${at.period} con otro importe (${at.amount.toFixed(2)}): revisar cuál corresponde; no se importa`);
            }
        }
    }
    const counts: Record<ImportRowStatus, number> = { OK: 0, DUPLICATE: 0, REVIEW: 0, ERROR: 0 };
    for (const r of parsed.rows) counts[r.status]++;
    const sum = (pred: (r: IibbImportRow) => boolean) => parsed.rows.filter((r) => pred(r) && r.amount).reduce((s, r) => s.plus(r.amount!), new Prisma.Decimal(0));
    const fileSha256 = createHash("sha256").update(file).digest("hex");
    const token = createHash("sha256")
        .update(JSON.stringify({ v: 1, periodId, fileSha256, rows: parsed.rows.map((r) => [r.line, r.status]), fileErrors: parsed.fileErrors }))
        .digest("hex");
    const meta = parsed.format ? IIBB_IMPORT_FORMATS[parsed.format] : null;
    return {
        format: parsed.format, formatLabel: meta?.label ?? null, jurisdictionCode: meta?.jurisdictionCode ?? null,
        rows: parsed.rows, fileErrors: parsed.fileErrors, counts,
        importableTotal: sum((r) => r.status === "OK").toFixed(2),
        excludedTotal: sum((r) => r.status !== "OK").toFixed(2),
        fileSha256, token,
    };
}

/** Descripción del registro importado (visible en Retenciones/Percepciones). */
export function iibbImportDescription(format: IibbImportFormat): string {
    return `Importada (${IIBB_IMPORT_FORMATS[format].label})`;
}
