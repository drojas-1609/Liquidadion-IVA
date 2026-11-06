import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { F2051_VOUCHER_TYPE_CODES, isDateInPeriod, parseIsoDateOnly } from "../api-input";
import { raise, type ImportRowStatus } from "./common";
import { parsePerceptionsCsv, perceptionKey, type PerceptionRow } from "./perceptions-csv";
import { parseRetentionsCsv, retentionKey, type RetentionLayout, type RetentionRow } from "./retentions-csv";

/**
 * Vista previa de la importación de retenciones o percepciones de IVA desde
 * las descargas de ARCA. Función pura sobre los datos ya leídos: la
 * confirmación la vuelve a ejecutar BAJO el bloqueo del período con las claves
 * existentes releídas.
 *  - fecha fuera del mes del período -> REVISAR (la app registra cada importe
 *    en el período de su fecha; otra imputación se carga a mano);
 *  - tipo de comprobante fuera de la tabla del F.2051 -> REVISAR;
 *  - importe sin decimales -> REVISAR salvo confirmación explícita de que son
 *    pesos enteros (`integerAmountsArePesos`);
 *  - ya registrada para el CLIENTE en cualquier período (misma clave que los
 *    índices únicos) -> YA CARGADA, indicando el período;
 *  - repetida dentro del archivo -> ERROR.
 */

export type TaxImportKind = "PERCEPTIONS" | "RETENTIONS";
export type TaxImportRow = (PerceptionRow | (RetentionRow & { regimeCode: number | null })) & { kind: TaxImportKind; certificateNumber?: string | null; taxCode?: number | null };

export interface TaxImportPreview {
    kind: TaxImportKind;
    layout: RetentionLayout | "PERCEPTIONS_DOWNLOAD" | null;
    rows: TaxImportRow[];
    fileErrors: string[];
    counts: Record<ImportRowStatus, number>;
    /** Sólo filas que se importan. Las demás quedan fuera de los totales. */
    importableTotal: string;
    /** Total de las filas que NO se importan (revisar / error / ya cargadas), para mostrarlas aparte. */
    excludedTotal: string;
    fileSha256: string;
    token: string;
}

type Db = Pick<PrismaClient, "taxRecord"> | Prisma.TransactionClient;

/** Claves ya registradas para el cliente en cualquiera de sus períodos, con el período. */
export async function existingTaxKeys(db: Db, scope: { organizationId: string; clientId: string }, kind: TaxImportKind): Promise<Map<string, string>> {
    const rows = await db.taxRecord.findMany({
        where: { organizationId: scope.organizationId, period: { clientId: scope.clientId }, nature: kind === "RETENTIONS" ? "RETENTION" : "PERCEPTION" },
        select: { regimeCode: true, agentCuit: true, voucherTypeCode: true, voucherNumber: true, certificateNumber: true, period: { select: { month: true, year: true } } },
    });
    return new Map(rows.map((r) => [kind === "RETENTIONS" ? retentionKey(r) : perceptionKey(r), `${String(r.period.month).padStart(2, "0")}/${r.period.year}`]));
}

export function buildTaxImportPreview(
    kind: TaxImportKind,
    file: Uint8Array,
    period: { month: number; year: number },
    existing: ReadonlyMap<string, string>,
    periodId: string,
    opts: { integerAmountsArePesos: boolean },
): TaxImportPreview {
    const ret = kind === "RETENTIONS" ? parseRetentionsCsv(file) : null;
    const parsed = ret ?? parsePerceptionsCsv(file);
    const layout = ret ? ret.layout : parsed.fileErrors.length ? null : "PERCEPTIONS_DOWNLOAD";
    const rows: TaxImportRow[] = parsed.rows.map((r) => ({ ...r, kind }));
    const seen = new Set<string>();
    for (const r of rows) {
        if (r.status === "ERROR") continue;
        const date = r.date ? parseIsoDateOnly(r.date) : null;
        if (!date || !isDateInPeriod(date, period)) raise(r, "REVIEW", `fecha fuera del período ${String(period.month).padStart(2, "0")}/${period.year}: si corresponde computarla acá, cargala a mano`);
        if (r.voucherTypeCode !== null && !F2051_VOUCHER_TYPE_CODES.includes(r.voucherTypeCode)) raise(r, "REVIEW", `tipo de comprobante ${r.voucherTypeCode} fuera de la tabla del F.2051`);
        if (r.integerAmount && !opts.integerAmountsArePesos) raise(r, "REVIEW", "importe sin decimales: confirmá que son pesos enteros (la descarga no lo indica)");
        const k = kind === "RETENTIONS" ? retentionKey(r as RetentionRow) : perceptionKey(r);
        if (seen.has(k)) raise(r, "ERROR", kind === "RETENTIONS" ? "certificado repetido en el archivo" : "percepción repetida en el archivo");
        seen.add(k);
        const at = existing.get(k);
        if ((r.status as ImportRowStatus) !== "ERROR" && at !== undefined) {
            r.messages.unshift(`ya registrada para el cliente en el período ${at}: se omite`);
            r.status = "DUPLICATE";
        }
    }
    const counts: Record<ImportRowStatus, number> = { OK: 0, DUPLICATE: 0, REVIEW: 0, ERROR: 0 };
    for (const r of rows) counts[r.status]++;
    const sumOf = (pred: (r: TaxImportRow) => boolean) => rows.filter((r) => pred(r) && r.amount).reduce((s, r) => s.plus(r.amount!), new Prisma.Decimal(0));
    const fileSha256 = createHash("sha256").update(file).digest("hex");
    const token = createHash("sha256")
        .update(JSON.stringify({ v: 2, kind, periodId, fileSha256, integer: opts.integerAmountsArePesos, rows: rows.map((r) => [r.line, r.status]), fileErrors: parsed.fileErrors }))
        .digest("hex");
    return {
        kind, layout, rows, fileErrors: parsed.fileErrors, counts,
        importableTotal: sumOf((r) => r.status === "OK").toFixed(2),
        excludedTotal: sumOf((r) => r.status !== "OK").toFixed(2),
        fileSha256, token,
    };
}
