import { Prisma } from "@prisma/client";
import { cuitCheckDigit } from "../cuit";

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

export type PerceptionRowStatus = "OK" | "DUPLICATE" | "REVIEW" | "ERROR";

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
}

export interface PerceptionsParse {
    rows: PerceptionRow[];
    fileErrors: string[];
}

export const PERCEPTION_FIELDS = 8;
const MAX_ROWS = 5000;

function validCuit(v: string): boolean {
    if (!/^\d{11}$/.test(v)) return false;
    const d = cuitCheckDigit(v.slice(0, 10));
    return d !== null && d === Number(v[10]);
}

/** Importe: "1234.56" (descarga observada) o "1234,56" (diseño publicado). Sin miles, hasta 2 decimales, > 0. */
function parseAmount(raw: string): Prisma.Decimal | null {
    const s = raw.trim();
    if (!/^\d{1,16}([.,]\d{1,2})?$/.test(s)) return null;
    const d = new Prisma.Decimal(s.replace(",", "."));
    return d.isZero() ? null : d;
}

export function parsePerceptionsCsv(bytes: Uint8Array): PerceptionsParse {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch {
        return { rows: [], fileErrors: ["el archivo no es texto (ASCII/UTF-8) como la descarga de percepciones"] };
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) return { rows: [], fileErrors: ["el archivo está vacío"] };
    if (lines.length > MAX_ROWS) return { rows: [], fileErrors: [`demasiadas filas (máximo ${MAX_ROWS})`] };
    if (/[A-Za-z]{3,}/.test(lines[0].split(";")[0] ?? "")) return { rows: [], fileErrors: ["la primera línea parece un encabezado: la descarga observada no lo trae (¿otro archivo?)"] };

    const rows = lines.map((l, i): PerceptionRow => {
        const row: PerceptionRow = { line: i + 1, status: "OK", messages: [], regimeCode: null, agentCuit: null, intermediaryCuit: null, date: null, voucherTypeCode: null, voucherNumber: null, amount: null };
        const raise = (status: PerceptionRowStatus, m: string) => {
            row.messages.push(m);
            const rank = { OK: 0, DUPLICATE: 1, REVIEW: 2, ERROR: 3 } as const;
            if (rank[status] > rank[row.status]) row.status = status;
        };
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
        const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
        const dt = dm ? new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]))) : null;
        if (dm && dt && dt.getUTCDate() === Number(dm[3]) && dt.getUTCMonth() === Number(dm[2]) - 1) row.date = date;
        else raise("ERROR", "fecha inválida (AAAA-MM-DD)");
        if (/^\d{1,3}$/.test(vtype) && Number(vtype) > 0) row.voucherTypeCode = Number(vtype);
        else raise("ERROR", "tipo de comprobante inválido");
        if (/^[0-9A-Za-z]{1,20}(-[0-9A-Za-z]+)?$/.test(vnumber) && vnumber.length <= 20) row.voucherNumber = vnumber;
        else raise("ERROR", "número de comprobante inválido");
        const a = parseAmount(amount);
        if (a) row.amount = a;
        else raise("ERROR", "importe inválido (positivo, sin separador de miles, hasta 2 decimales)");
        return row;
    });
    return { rows, fileErrors: [] };
}

/** Clave de duplicidad, la misma del índice único TaxRecord_perception_voucher_key. */
export function perceptionKey(r: { regimeCode: number | null; agentCuit: string | null; voucherTypeCode: number | null; voucherNumber: string | null }): string {
    return `${r.regimeCode}|${r.agentCuit}|${r.voucherTypeCode}|${r.voucherNumber}`;
}
