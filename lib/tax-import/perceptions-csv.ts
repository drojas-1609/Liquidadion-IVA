import type { Prisma } from "@prisma/client";
import { parseTaxAmount, raise as raiseRow, textLines, validCuit, validIsoDate, type ImportRowStatus } from "./common";

/**
 * Lectura de la descarga de **percepciones impositivas de IVA** de ARCA
 * (`Percepciones-impositivas-AAAAMM.csv`), según la muestra observada el
 * 06/11/2026 (período 10/2026). ARCA no publica el diseño de ESTA descarga.
 * Observado:
 *  - sin encabezado; separador ";"; salto LF; ASCII;
 *  - 8 campos: régimen · campo sin documentar (observado "0") · CUIT agente ·
 *    CUIT intermediario (vacío) · fecha AAAA-MM-DD · tipo de comprobante (tabla
 *    del F.2051) · número de comprobante (16 dígitos) · importe con PUNTO decimal.
 *
 * Difiere del diseño de IMPORTACIÓN publicado del F.2051
 * (F2051-IVA-especificacion-de-importaciones.pdf, 12/11/2025: 7 campos, importe
 * con coma). Por eso este lector acepta sólo el formato observado de la
 * descarga y deja para revisión lo que no coincide; no se infiere el campo 2
 * (si no es "0", la fila queda para revisión). El exportador del F.2051 sigue
 * el diseño publicado (ver docs/presentacion-iva/README.md).
 */

export type PerceptionRowStatus = ImportRowStatus;

export interface PerceptionRow {
    line: number;
    status: PerceptionRowStatus;
    messages: string[];
    regimeCode: number | null;
    agentCuit: string | null;
    intermediaryCuit: string | null;
    /** AAAA-MM-DD. */
    date: string | null;
    voucherTypeCode: number | null;
    voucherNumber: string | null;
    amount: Prisma.Decimal | null;
    /** Importe sin separador decimal (ambiguo). */
    integerAmount: boolean;
}

export interface PerceptionsParse {
    rows: PerceptionRow[];
    fileErrors: string[];
}

export const PERCEPTION_FIELDS = 8;
const MAX_ROWS = 5000;

export function parsePerceptionsCsv(bytes: Uint8Array): PerceptionsParse {
    const t = textLines(bytes, "descarga de percepciones", MAX_ROWS);
    if ("error" in t) return { rows: [], fileErrors: [t.error] };
    const lines = t.lines;

    const rows = lines.map((l, i): PerceptionRow => {
        const row: PerceptionRow = { line: i + 1, status: "OK", messages: [], regimeCode: null, agentCuit: null, intermediaryCuit: null, date: null, voucherTypeCode: null, voucherNumber: null, amount: null, integerAmount: false };
        const raise = (status: PerceptionRowStatus, m: string) => raiseRow(row, status, m);
        const f = l.split(";").map((x) => x.trim());
        if (f.length !== PERCEPTION_FIELDS) {
            raise("ERROR", `la fila tiene ${f.length} campos y la descarga observada ${PERCEPTION_FIELDS}`);
            return row;
        }
        const [regime, field2, agent, intermediary, date, vtype, vnumber, amount] = f;
        if (/^\d{1,5}$/.test(regime) && Number(regime) > 0) row.regimeCode = Number(regime);
        else raise("ERROR", "régimen inválido");
        if (field2 !== "0") raise("REVIEW", `el segundo campo vale «${field2}»: la muestra observada trae 0 y el diseño publicado no lo documenta`);
        if (validCuit(agent)) row.agentCuit = agent;
        else raise("ERROR", "CUIT del agente inválido");
        if (intermediary !== "") {
            if (validCuit(intermediary)) row.intermediaryCuit = intermediary;
            else raise("ERROR", "CUIT intermediario inválido");
        }
        if (validIsoDate(date)) row.date = date;
        else raise("ERROR", "fecha inválida (AAAA-MM-DD)");
        if (/^\d{1,3}$/.test(vtype) && Number(vtype) > 0) row.voucherTypeCode = Number(vtype);
        else raise("ERROR", "tipo de comprobante inválido");
        if (/^[0-9A-Za-z]{1,20}(-[0-9A-Za-z]+)?$/.test(vnumber) && vnumber.length <= 20) row.voucherNumber = vnumber;
        else raise("ERROR", "número de comprobante inválido");
        const a = parseTaxAmount(amount);
        if (a) {
            row.amount = a.value;
            row.integerAmount = a.integer;
        }
        else raise("ERROR", "importe inválido (positivo, sin separador de miles, hasta 2 decimales)");
        return row;
    });
    return { rows, fileErrors: [] };
}
