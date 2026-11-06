import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { F2051_VOUCHER_TYPE_CODES, isDateInPeriod, parseIsoDateOnly } from "../api-input";
import { parsePerceptionsCsv, perceptionKey, type PerceptionRow } from "./perceptions-csv";

/**
 * Vista previa de la importación de percepciones de IVA (descarga de ARCA).
 * Función pura sobre los datos ya leídos: la confirmación la vuelve a
 * ejecutar BAJO el bloqueo del período con las claves existentes releídas.
 *  - fecha fuera del mes del período -> REVISAR (la app registra cada
 *    percepción en el período de su fecha; la imputación a otro período según
 *    RG 5750 se carga a mano);
 *  - tipo de comprobante fuera de la tabla del F.2051 -> REVISAR;
 *  - ya registrada en el período (misma clave que el índice único) -> YA CARGADA;
 *  - repetida dentro del archivo -> ERROR.
 */

export interface PerceptionsPreview {
    rows: PerceptionRow[];
    fileErrors: string[];
    counts: Record<PerceptionRow["status"], number>;
    importableTotal: string;
    fileSha256: string;
    token: string;
}

type Db = Pick<PrismaClient, "taxRecord"> | Prisma.TransactionClient;

export async function existingPerceptionKeys(db: Db, scope: { organizationId: string; periodId: string }): Promise<Set<string>> {
    const rows = await db.taxRecord.findMany({
        where: { periodId: scope.periodId, organizationId: scope.organizationId, nature: "PERCEPTION" },
        select: { regimeCode: true, agentCuit: true, voucherTypeCode: true, voucherNumber: true },
    });
    return new Set(rows.map(perceptionKey));
}

export function buildPerceptionsPreview(file: Uint8Array, period: { month: number; year: number }, existing: ReadonlySet<string>, periodId: string): PerceptionsPreview {
    const parsed = parsePerceptionsCsv(file);
    const seen = new Set<string>();
    for (const r of parsed.rows) {
        if (r.status === "ERROR") continue;
        const bump = (status: PerceptionRow["status"], m: string) => {
            r.messages.push(m);
            const rank = { OK: 0, DUPLICATE: 1, REVIEW: 2, ERROR: 3 } as const;
            if (rank[status] > rank[r.status]) r.status = status;
        };
        const date = r.date ? parseIsoDateOnly(r.date) : null;
        if (!date || !isDateInPeriod(date, period)) bump("REVIEW", `fecha fuera del período ${String(period.month).padStart(2, "0")}/${period.year}: si corresponde computarla acá (RG 5750), cargala a mano`);
        if (r.voucherTypeCode !== null && !F2051_VOUCHER_TYPE_CODES.includes(r.voucherTypeCode)) bump("REVIEW", `tipo de comprobante ${r.voucherTypeCode} fuera de la tabla del F.2051`);
        const k = perceptionKey(r);
        if (seen.has(k)) bump("ERROR", "percepción repetida en el archivo");
        seen.add(k);
        if ((r.status as PerceptionRow["status"]) !== "ERROR" && existing.has(k)) {
            r.messages.unshift("ya registrada en el período: se omite");
            r.status = "DUPLICATE";
        }
    }
    const counts = { OK: 0, DUPLICATE: 0, REVIEW: 0, ERROR: 0 };
    for (const r of parsed.rows) counts[r.status]++;
    const total = parsed.rows.filter((r) => r.status === "OK").reduce((s, r) => s.plus(r.amount!), new Prisma.Decimal(0));
    const fileSha256 = createHash("sha256").update(file).digest("hex");
    const token = createHash("sha256").update(JSON.stringify({ v: 1, periodId, fileSha256, rows: parsed.rows.map((r) => [r.line, r.status]), fileErrors: parsed.fileErrors })).digest("hex");
    return { rows: parsed.rows, fileErrors: parsed.fileErrors, counts, importableTotal: total.toFixed(2), fileSha256, token };
}
