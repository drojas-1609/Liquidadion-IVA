import "server-only";
import { Prisma } from "@prisma/client";
import { ExportFormatError, crlfJoin, csvAmount, encodeAnsi } from "./text";
import type { ExportFile, ExportTaxRecord, OmittedFile } from "./types";

/**
 * Archivos de importación de retenciones, percepciones y percepciones
 * aduaneras del F.2051 (IVA Simple), según "F.2051 – Especificación de
 * importaciones" (https://www.arca.gob.ar/iva/documentos/F2051-IVA-especificacion-de-importaciones.pdf,
 * 12/11/2025, consultado el 06/11/2026):
 *  - CSV RFC 4180 con ";" como separador; enteros sin separador de miles;
 *    importes con "," decimal, hasta 16 enteros y 2 decimales; fechas ISO 8601
 *    (aaaa-mm-dd); texto con "-" intermedios;
 *  - Retenciones: impuesto (767 o 216) · régimen · CUIT agente · CUIT
 *    intermediario (vacío si no hay: ";;") · fecha · tipo de comprobante ·
 *    número · certificado · importe (> 0);
 *  - Percepciones: régimen · CUIT agente · CUIT intermediario · fecha · tipo
 *    de comprobante · número · importe (> 0);
 *  - Percepciones aduaneras: régimen · fecha · liquidación o despacho ·
 *    importe (positivo o negativo).
 * El diseño no prevé encabezado: los archivos van sin él. Las fechas y
 * vigencias de régimen las valida ARCA al importar.
 */

export const F2051_FILE_NAMES = {
    RETENTIONS: "F2051_RETENCIONES.csv",
    PERCEPTIONS: "F2051_PERCEPCIONES.csv",
    CUSTOMS: "F2051_PERCEPCIONES_ADUANERAS.csv",
} as const;

const MAX_INT = 16;
const NUMBER_RE = /^[0-9A-Za-z]+(-[0-9A-Za-z]+)?$/;
const CUSTOMS_RE = /^\d{2}-\d{3}-[0-9A-Z]{4}-\d{6}-[A-HJ-NPR-Z]$/;

function text(v: string | null, what: string): string {
    if (v === null || !NUMBER_RE.test(v)) throw new ExportFormatError(`${what} inválido para el F.2051`);
    return v;
}
function int(v: number | null, what: string): string {
    if (v === null || !Number.isInteger(v) || v <= 0) throw new ExportFormatError(`${what} inválido para el F.2051`);
    return String(v);
}
function cuit(v: string | null, what: string, optional = false): string {
    if (v === null && optional) return "";
    if (v === null || !/^\d{11}$/.test(v)) throw new ExportFormatError(`${what} inválido para el F.2051`);
    return v;
}
function positive(v: Prisma.Decimal): string {
    if (!v.isPositive() || v.isZero()) throw new ExportFormatError("importe de retención o percepción no positivo");
    return csvAmount(v, MAX_INT);
}
function signed(v: Prisma.Decimal): string {
    return (v.isNegative() ? "-" : "") + csvAmount(v.abs(), MAX_INT);
}
function date(iso: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new ExportFormatError("fecha inválida");
    return iso;
}

export interface F2051Result {
    files: ExportFile[];
    omitted: OmittedFile[];
    totals: { retentions: Prisma.Decimal; perceptions: Prisma.Decimal; customs: Prisma.Decimal };
}

/** Sólo los registros de IVA (los de IIBB no van en la presentación de IVA). */
export function writeF2051Files(records: ExportTaxRecord[]): F2051Result {
    const iva = [...records].filter((r) => r.type.includes("IVA")).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const ret: string[] = [], per: string[] = [], cus: string[] = [];
    let tr = new Prisma.Decimal(0), tp = new Prisma.Decimal(0), tc = new Prisma.Decimal(0);
    for (const r of iva) {
        if (r.nature === "RETENTION") {
            if (r.taxCode !== 767 && r.taxCode !== 216) throw new ExportFormatError("impuesto de la retención: 767 o 216");
            ret.push([String(r.taxCode), int(r.regimeCode, "régimen"), cuit(r.agentCuit, "CUIT del agente"), cuit(r.intermediaryCuit, "CUIT intermediario", true),
                date(r.date), int(r.voucherTypeCode, "tipo de comprobante"), text(r.voucherNumber, "número de comprobante"), text(r.certificateNumber, "certificado"), positive(r.amount)].join(";"));
            tr = tr.plus(r.amount);
        } else if (r.nature === "PERCEPTION") {
            per.push([int(r.regimeCode, "régimen"), cuit(r.agentCuit, "CUIT del agente"), cuit(r.intermediaryCuit, "CUIT intermediario", true),
                date(r.date), int(r.voucherTypeCode, "tipo de comprobante"), text(r.voucherNumber, "número de comprobante"), positive(r.amount)].join(";"));
            tp = tp.plus(r.amount);
        } else if (r.nature === "CUSTOMS_PERCEPTION") {
            if (r.customsDocument === null || !CUSTOMS_RE.test(r.customsDocument)) throw new ExportFormatError("liquidación o despacho con formato 99-999-XXXX-999999-X");
            cus.push([int(r.regimeCode, "régimen"), date(r.date), r.customsDocument, signed(r.amount)].join(";"));
            tc = tc.plus(r.amount);
        } else {
            throw new ExportFormatError("retención o percepción de IVA sin naturaleza");
        }
    }
    const files: ExportFile[] = [], omitted: OmittedFile[] = [];
    const push = (name: string, lines: string[], what: string) => {
        if (lines.length) files.push({ name, bytes: encodeAnsi(crlfJoin(lines)), records: lines.length });
        else omitted.push({ name, reason: `no hay ${what} registradas en el período` });
    };
    push(F2051_FILE_NAMES.RETENTIONS, ret, "retenciones de IVA");
    push(F2051_FILE_NAMES.PERCEPTIONS, per, "percepciones de IVA");
    push(F2051_FILE_NAMES.CUSTOMS, cus, "percepciones aduaneras de IVA");
    return { files, omitted, totals: { retentions: tr, perceptions: tp, customs: tc } };
}

/** Formato de liquidación o despacho de la percepción aduanera. */
export function isCustomsDocument(v: string): boolean {
    return CUSTOMS_RE.test(v);
}
/** Formato de número de comprobante / certificado del F.2051 (único "-" intermedio). */
export function isF2051Number(v: string): boolean {
    return NUMBER_RE.test(v);
}
