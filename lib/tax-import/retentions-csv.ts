import type { Prisma } from "@prisma/client";
import { raise, parseTaxAmount, textLines, validCuit, validIsoDate, voucherNumberFormatOk, type ImportRowStatus } from "./common";

/**
 * Lectura de retenciones de IVA con certificado. Se aceptan las DOS formas
 * observadas el 06/11/2026 (muestras de 09/2026), sin encabezado y separadas
 * por ";":
 *  - DISEÑO F.2051 (9 campos), igual al diseño de importación publicado
 *    (F2051-IVA-especificacion-de-importaciones.pdf, 12/11/2025): impuesto ·
 *    régimen · CUIT agente · CUIT intermediario · fecha · tipo de comprobante ·
 *    número · certificado · importe;
 *  - DESCARGA de ARCA (10 campos, `Retenciones-AAAAMM.csv`): la misma
 *    secuencia con un campo sin documentar después del régimen (observado
 *    "0", como en la descarga de percepciones).
 * Todas las filas del archivo deben tener la misma cantidad de campos.
 *
 * Reglas (sin inventar datos; lo ambiguo queda para revisar):
 *  - impuesto 767 o 216 ("según corresponda", diseño publicado); otro -> error;
 *  - CUIT del agente (e intermediario, si viene) con dígito verificador;
 *  - fecha ISO válida; el período lo controla el servicio;
 *  - tipo de comprobante de la tabla y número con el formato de ese tipo; si
 *    no coincide -> revisar;
 *  - certificado obligatorio;
 *  - importe positivo; SIN decimales -> revisar salvo confirmación explícita
 *    (en las muestras no se puede saber si son pesos enteros o centavos).
 */

export type RetentionLayout = "F2051_DESIGN" | "ARCA_DOWNLOAD";

export interface RetentionRow {
    line: number;
    status: ImportRowStatus;
    messages: string[];
    taxCode: number | null;
    regimeCode: number | null;
    agentCuit: string | null;
    intermediaryCuit: string | null;
    date: string | null;
    voucherTypeCode: number | null;
    voucherNumber: string | null;
    certificateNumber: string | null;
    amount: Prisma.Decimal | null;
    /** Importe sin separador decimal (ambiguo). */
    integerAmount: boolean;
}

export interface RetentionsParse {
    layout: RetentionLayout | null;
    rows: RetentionRow[];
    fileErrors: string[];
}

const MAX_ROWS = 5000;

export function parseRetentionsCsv(bytes: Uint8Array): RetentionsParse {
    const t = textLines(bytes, "descarga de retenciones", MAX_ROWS);
    if ("error" in t) return { layout: null, rows: [], fileErrors: [t.error] };
    const counts = new Set(t.lines.map((l) => l.split(";").length));
    if (counts.size !== 1) return { layout: null, rows: [], fileErrors: ["las filas tienen distinta cantidad de campos"] };
    const n = [...counts][0];
    const layout: RetentionLayout | null = n === 9 ? "F2051_DESIGN" : n === 10 ? "ARCA_DOWNLOAD" : null;
    if (!layout) return { layout: null, rows: [], fileErrors: [`${n} campos por fila: se esperan 9 (diseño del F.2051) o 10 (descarga de ARCA)`] };

    const rows = t.lines.map((l, i): RetentionRow => {
        const row: RetentionRow = { line: i + 1, status: "OK", messages: [], taxCode: null, regimeCode: null, agentCuit: null, intermediaryCuit: null, date: null, voucherTypeCode: null, voucherNumber: null, certificateNumber: null, amount: null, integerAmount: false };
        const f = l.split(";").map((x) => x.trim());
        if (layout === "ARCA_DOWNLOAD") {
            const extra = f.splice(2, 1)[0];
            if (extra !== "0") raise(row, "REVIEW", `el tercer campo vale «${extra}»: la descarga observada trae 0 y el diseño publicado no lo documenta`);
        }
        const [tax, regime, agent, intermediary, date, vtype, vnumber, cert, amount] = f;
        if (tax === "767" || tax === "216") row.taxCode = Number(tax);
        else raise(row, "ERROR", `impuesto ${tax}: la importación de retenciones de IVA admite 767 o 216`);
        if (/^\d{1,5}$/.test(regime) && Number(regime) > 0) row.regimeCode = Number(regime);
        else raise(row, "ERROR", "régimen inválido");
        if (validCuit(agent)) row.agentCuit = agent;
        else raise(row, "ERROR", "CUIT del agente inválido");
        if (intermediary !== "") {
            if (validCuit(intermediary)) row.intermediaryCuit = intermediary;
            else raise(row, "ERROR", "CUIT intermediario inválido");
        }
        if (validIsoDate(date)) row.date = date;
        else raise(row, "ERROR", "fecha inválida (AAAA-MM-DD)");
        if (/^\d{1,3}$/.test(vtype) && Number(vtype) > 0) {
            row.voucherTypeCode = Number(vtype);
            if (/^[0-9A-Za-z-]{1,20}$/.test(vnumber)) {
                row.voucherNumber = vnumber;
                const fmt = voucherNumberFormatOk(row.voucherTypeCode, vnumber);
                if (fmt === null) raise(row, "REVIEW", `tipo de comprobante ${vtype} fuera de la tabla del F.2051`);
                else if (!fmt) raise(row, "REVIEW", `el número no tiene el formato del tipo de comprobante ${vtype} en la tabla del F.2051`);
            } else raise(row, "ERROR", "número de comprobante inválido");
        } else raise(row, "ERROR", "tipo de comprobante inválido");
        if (/^[0-9A-Za-z-]{1,40}$/.test(cert)) row.certificateNumber = cert;
        else raise(row, "ERROR", "número de certificado faltante o inválido");
        const a = parseTaxAmount(amount);
        if (a) {
            row.amount = a.value;
            row.integerAmount = a.integer;
        } else raise(row, "ERROR", "importe inválido (positivo, sin separador de miles, hasta 2 decimales)");
        return row;
    });
    return { layout, rows, fileErrors: [] };
}
