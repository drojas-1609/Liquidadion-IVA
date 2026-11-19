import { Prisma } from "@prisma/client";
import { raise, validCuit, type ImportRowStatus } from "../tax-import/common";

/**
 * Lectores (lógica pura) de las deducciones de Ingresos Brutos que informa el
 * fisco: retenciones, percepciones y recaudaciones bancarias.
 *
 * Fuentes de cada formato:
 *  - e-SICOL (AGIP, CABA), percepciones y retenciones: diseño publicado por AGIP en
 *    «Aplicativo e-SICOL - Preguntas útiles» (consultado el 18/11/2026):
 *    CUIT del agente (11) · número de comprobante (8) · fecha aaaammdd (8) ·
 *    sucursal (4) · monto base (16; 14 enteros y 2 decimales, espacios a la
 *    izquierda) · importe (16) · tipo de comprobante (F, R, C, D) · letra
 *    (A, B, C, M, T). Es el orden de las percepciones. Las retenciones que
 *    descarga AGIP («…EsicolRetenciones-Completo.txt», muestra del 17/11/2026)
 *    traen CUIT · fecha · número de constancia (8) · base · importe, en ese
 *    orden y sin sucursal, tipo ni letra (59 caracteres).
 *  - e-SICOL, recaudaciones bancarias: AGIP no publica el diseño en esa página
 *    (remite a la ayuda del aplicativo). Según la muestra observada: CUIT del
 *    banco (11) · fecha aaaammdd (8) · importe (16) · 6 caracteres sin
 *    documentar · CBU (22), 63 caracteres. Los 6 caracteres se conservan tal
 *    cual, sin interpretarlos.
 *  - Rentas Ciudad (AGIP), consultas «RentasCiudad*.xls»: en realidad CSV
 *    (primera línea «sep=,», encabezado con nombres de columna, valores entre
 *    comillas, Latin-1). Muestras del 17/11/2026: retenciones, percepciones y
 *    recaudaciones bancarias. Se leen por nombre de columna.
 *  - Santa Cruz, descarga «retenciones-percepciones-diu.zip» (muestra del
 *    17/11/2026, sin diseño publicado a la vista): retenciones = fecha
 *    dd/mm/aaaa (10) · CUIT del agente (11) · número de constancia (15) ·
 *    importe (15, coma decimal), 51 caracteres; bancarias = período aaaamm (6) ·
 *    CBU (22) · importe (15, coma decimal), 43 caracteres. Los totales coinciden
 *    con los resúmenes SIRTAC y SIRCREB del mismo período (jurisdicción 920).
 *    Percepciones (53 caracteres), dos variantes del mismo diseño de importación
 *    del F.5680 (manual «Mis Aplicaciones Web — F.5680 SANTA CRUZ DIU ISIB»:
 *    fecha 1-10 · CUIT del agente 11-21 · letra 22 · tipo 23 · número 24-38 ·
 *    importe 39-53; los códigos de letra y tipo se leyeron de los combos del
 *    formulario el 18/11/2026: letra 1=A 2=B 3=C 4=E 5=M; tipo 1=Factura
 *    2=Recibo 3=Nota de crédito 4=Nota de débito 5=Otros):
 *      · codificada (la que acepta el F.5680): número «PPPP-NNNNNNNN»;
 *      · la que descarga ASIP («percepcionesExport.txt», muestra OOSHEN
 *        10/2026): tipo y letra como texto e invertidos («1A» factura A, «6A»
 *        nota de crédito A, «F » factura) y el número sin el comprobante (sólo
 *        el punto de venta): ARCA la rechaza; acá se lee sin número y se
 *        concilia por agente, fecha e importe. Notas de crédito con el signo
 *        dentro del campo («00000000-525,62»).
 *    Percepciones aduaneras vinieron vacías: sin muestra no se leen.
 *
 * Nada de esto se adivina: un registro que no respeta su formato queda en
 * ERROR con el motivo, y lo dudoso en REVISAR.
 */

export type IibbImportFormat =
    | "ESICOL_PERCEPCIONES"
    | "ESICOL_RETENCIONES"
    | "ESICOL_BANCARIAS"
    | "RENTAS_CIUDAD_PERCEPCIONES"
    | "RENTAS_CIUDAD_RETENCIONES"
    | "RENTAS_CIUDAD_BANCARIAS"
    | "SANTA_CRUZ_RETENCIONES"
    | "SANTA_CRUZ_PERCEPCIONES"
    | "SANTA_CRUZ_BANCARIAS";

export const IIBB_IMPORT_FORMATS: Readonly<Record<IibbImportFormat, { label: string; jurisdictionCode: string; type: IibbDeductionType }>> = {
    ESICOL_PERCEPCIONES: { label: "e-SICOL (AGIP) — percepciones", jurisdictionCode: "901", type: "PERCEPCION IIBB" },
    ESICOL_RETENCIONES: { label: "e-SICOL (AGIP) — retenciones", jurisdictionCode: "901", type: "RETENCION IIBB" },
    ESICOL_BANCARIAS: { label: "e-SICOL (AGIP) — recaudaciones bancarias", jurisdictionCode: "901", type: "SIRCREB" },
    RENTAS_CIUDAD_PERCEPCIONES: { label: "Rentas Ciudad (AGIP) — percepciones", jurisdictionCode: "901", type: "PERCEPCION IIBB" },
    RENTAS_CIUDAD_RETENCIONES: { label: "Rentas Ciudad (AGIP) — retenciones", jurisdictionCode: "901", type: "RETENCION IIBB" },
    RENTAS_CIUDAD_BANCARIAS: { label: "Rentas Ciudad (AGIP) — recaudaciones bancarias", jurisdictionCode: "901", type: "SIRCREB" },
    SANTA_CRUZ_RETENCIONES: { label: "Santa Cruz — retenciones", jurisdictionCode: "920", type: "RETENCION IIBB" },
    SANTA_CRUZ_PERCEPCIONES: { label: "Santa Cruz — percepciones", jurisdictionCode: "920", type: "PERCEPCION IIBB" },
    SANTA_CRUZ_BANCARIAS: { label: "Santa Cruz — recaudaciones bancarias", jurisdictionCode: "920", type: "SIRCREB" },
};

export type IibbDeductionType = "RETENCION IIBB" | "PERCEPCION IIBB" | "SIRCREB";

export interface IibbImportRow {
    line: number;
    status: ImportRowStatus;
    messages: string[];
    type: IibbDeductionType;
    jurisdictionCode: string;
    agentCuit: string | null;
    agentName: string | null;
    /** AAAA-MM-DD. Bancarias de Santa Cruz: sólo período (se toma el último día). */
    date: string | null;
    /** F, R, C o D (tabla de e-SICOL). */
    voucherKind: string | null;
    /** A, B, C, M o T. */
    voucherLetter: string | null;
    pointOfSale: string | null;
    voucherNumber: string | null;
    certificateNumber: string | null;
    baseAmount: Prisma.Decimal | null;
    /** Con signo: una nota de crédito (tipo C) resta. */
    amount: Prisma.Decimal | null;
    cbu: string | null;
    /** e-SICOL bancarias: los 6 caracteres sin documentar, tal cual. */
    rawBankExtra: string | null;
    /** Identidad para no duplicar (por formato). */
    identity: string | null;
}

export interface IibbImportParse {
    format: IibbImportFormat | null;
    rows: IibbImportRow[];
    fileErrors: string[];
}

const MAX_ROWS = 5000;

function decodeText(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch {
        // Rentas Ciudad descarga en Latin-1 («N° Ader»).
        return new TextDecoder("latin1").decode(bytes);
    }
}

function blankRow(line: number, format: IibbImportFormat): IibbImportRow {
    const f = IIBB_IMPORT_FORMATS[format];
    return {
        line, status: "OK", messages: [], type: f.type, jurisdictionCode: f.jurisdictionCode,
        agentCuit: null, agentName: null, date: null, voucherKind: null, voucherLetter: null, pointOfSale: null,
        voucherNumber: null, certificateNumber: null, baseAmount: null, amount: null, cbu: null, rawBankExtra: null, identity: null,
    };
}

/** Fecha válida en ISO desde aaaammdd. */
function ymd(raw: string): string | null {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
    return m ? iso(+m[1], +m[2], +m[3]) : null;
}
/** Fecha válida en ISO desde dd/mm/aaaa. */
function dmy(raw: string): string | null {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
    return m ? iso(+m[3], +m[2], +m[1]) : null;
}
function iso(y: number, mo: number, d: number): string | null {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Importe de ancho fijo: espacios o ceros a la izquierda, punto o coma decimal con 2 decimales. */
function fixedAmount(raw: string, sep: "." | "," | "either"): Prisma.Decimal | null {
    const s = raw.trim();
    const re = sep === "." ? /^\d{1,14}\.\d{2}$/ : sep === "," ? /^\d{1,14},\d{2}$/ : /^\d{1,14}[.,]\d{2}$/;
    if (!re.test(s)) return null;
    return new Prisma.Decimal(s.replace(",", "."));
}

function checkCuit(row: IibbImportRow, cuit: string, label = "CUIT del agente"): void {
    if (!validCuit(cuit)) raise(row, "ERROR", `${label} inválido: ${cuit.trim() || "(vacío)"}`);
    else row.agentCuit = cuit;
}
function checkCbu(row: IibbImportRow, cbu: string): void {
    if (!/^\d{22}$/.test(cbu)) raise(row, "ERROR", "CBU/CVU inválido (deben ser 22 dígitos)");
    else row.cbu = cbu;
}
function needPositive(row: IibbImportRow, v: Prisma.Decimal | null, label: string): Prisma.Decimal | null {
    if (v === null) { raise(row, "ERROR", `${label} con formato inválido`); return null; }
    if (v.isZero()) { raise(row, "REVIEW", `${label} en cero`); }
    return v;
}

// ── Identidad ──────────────────────────────────────────────────────────────
// AGIP informa lo mismo en dos formatos (e-SICOL y Rentas Ciudad) con distinto
// detalle: e-SICOL trae los últimos 8 dígitos del número y, en las muestras,
// letra «T» donde Rentas Ciudad trae el número completo y la letra «A». La
// identidad usa lo que ambos comparten, para que importar los dos no duplique.
const last8 = (v: string) => v.replace(/\D/g, "").slice(-8).padStart(8, "0");
const perceptionIdentity = (cuit: string, kind: string | null, number: string) => `P|${cuit}|${kind ?? ""}|${last8(number)}`;
const retentionIdentity = (cuit: string, date: string, number: string) => `R|${cuit}|${date}|${last8(number)}`;
function bankIdentity(ordinal: Map<string, number>, cuit: string, date: string, cbu: string, amount: Prisma.Decimal): string {
    // Mismo banco, fecha, CBU e importe dos veces son recaudaciones distintas: se numeran.
    const base = `B|${cuit}|${date}|${cbu}|${amount.toFixed(2)}`;
    const k = (ordinal.get(base) ?? 0) + 1;
    ordinal.set(base, k);
    return `${base}|${k}`;
}

// ── e-SICOL ────────────────────────────────────────────────────────────────

function esicolPercepcion(line: string, n: number): IibbImportRow {
    const r = blankRow(n, "ESICOL_PERCEPCIONES");
    checkCuit(r, line.slice(0, 11));
    const nro = line.slice(11, 19).trim();
    r.date = ymd(line.slice(19, 27));
    if (!r.date) raise(r, "ERROR", "fecha inválida (aaaammdd)");
    const suc = line.slice(27, 31).trim();
    r.baseAmount = needPositive(r, fixedAmount(line.slice(31, 47), "."), "monto base");
    const amount = needPositive(r, fixedAmount(line.slice(47, 63), "."), "importe");
    r.voucherKind = line[63] ?? null;
    r.voucherLetter = line[64] ?? null;
    if (!/^\d{1,8}$/.test(nro)) raise(r, "ERROR", "número de comprobante inválido");
    else r.voucherNumber = nro.padStart(8, "0");
    if (suc !== "" && !/^\d{1,4}$/.test(suc)) raise(r, "ERROR", "sucursal inválida");
    else r.pointOfSale = suc === "" ? null : suc.padStart(4, "0");
    if (!r.voucherKind || !"FRCD".includes(r.voucherKind)) raise(r, "ERROR", `tipo de comprobante «${r.voucherKind ?? ""}» fuera de la tabla de AGIP (F, R, C, D)`);
    if (!r.voucherLetter || !"ABCMT".includes(r.voucherLetter)) raise(r, "ERROR", `letra «${r.voucherLetter ?? ""}» fuera de la tabla de AGIP (A, B, C, M, T)`);
    // Nota de crédito: la percepción resta (criterio del estudio, 17/11/2026).
    r.amount = amount && r.voucherKind === "C" ? amount.negated() : amount;
    r.identity = r.agentCuit && r.voucherNumber ? perceptionIdentity(r.agentCuit, r.voucherKind, r.voucherNumber) : null;
    return r;
}

function esicolRetencion(line: string, n: number): IibbImportRow {
    const r = blankRow(n, "ESICOL_RETENCIONES");
    checkCuit(r, line.slice(0, 11));
    r.date = ymd(line.slice(11, 19));
    if (!r.date) raise(r, "ERROR", "fecha inválida (aaaammdd)");
    const nro = line.slice(19, 27).trim();
    if (!/^\d{1,8}$/.test(nro)) raise(r, "ERROR", "número de constancia inválido");
    else r.certificateNumber = nro.padStart(8, "0");
    r.baseAmount = needPositive(r, fixedAmount(line.slice(27, 43), "."), "monto base");
    r.amount = needPositive(r, fixedAmount(line.slice(43, 59), "."), "importe");
    r.identity = r.agentCuit && r.certificateNumber && r.date ? retentionIdentity(r.agentCuit, r.date, r.certificateNumber) : null;
    return r;
}

function esicolBancaria(line: string, n: number, ordinal: Map<string, number>): IibbImportRow {
    const r = blankRow(n, "ESICOL_BANCARIAS");
    checkCuit(r, line.slice(0, 11), "CUIT del banco");
    r.date = ymd(line.slice(11, 19));
    if (!r.date) raise(r, "ERROR", "fecha inválida (aaaammdd)");
    r.amount = needPositive(r, fixedAmount(line.slice(19, 35), "."), "importe");
    r.rawBankExtra = line.slice(35, 41);
    checkCbu(r, line.slice(41, 63));
    r.identity = r.agentCuit && r.date && r.cbu && r.amount ? bankIdentity(ordinal, r.agentCuit, r.date, r.cbu, r.amount) : null;
    return r;
}

// ── Santa Cruz ─────────────────────────────────────────────────────────────

function santaCruzRetencion(line: string, n: number): IibbImportRow {
    const r = blankRow(n, "SANTA_CRUZ_RETENCIONES");
    r.date = dmy(line.slice(0, 10));
    if (!r.date) raise(r, "ERROR", "fecha inválida (dd/mm/aaaa)");
    checkCuit(r, line.slice(10, 21));
    const cert = line.slice(21, 36);
    if (!/^\d{15}$/.test(cert)) raise(r, "ERROR", "número de constancia inválido (15 dígitos)");
    else r.certificateNumber = cert;
    r.amount = needPositive(r, fixedAmount(line.slice(36, 51), ","), "importe");
    r.identity = r.agentCuit && r.certificateNumber ? `R|${r.agentCuit}|${r.certificateNumber}` : null;
    return r;
}

function santaCruzBancaria(line: string, n: number, ordinal: Map<string, number>): IibbImportRow {
    const r = blankRow(n, "SANTA_CRUZ_BANCARIAS");
    const m = /^(\d{4})(\d{2})$/.exec(line.slice(0, 6));
    const y = m ? +m[1] : 0, mo = m ? +m[2] : 0;
    // Sólo informa el período: se registra al último día del mes.
    r.date = m && mo >= 1 && mo <= 12 ? iso(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate()) : null;
    if (!r.date) raise(r, "ERROR", "período inválido (aaaamm)");
    else r.messages.push("el archivo sólo informa el período: se registra al último día del mes");
    checkCbu(r, line.slice(6, 28));
    r.amount = needPositive(r, fixedAmount(line.slice(28, 43), ","), "importe");
    if (r.cbu && r.date && r.amount) {
        // Mismo CBU e importe dos veces en el mes son recaudaciones distintas: se numeran.
        const base = `B|${r.date.slice(0, 7)}|${r.cbu}|${r.amount.toFixed(2)}`;
        const k = (ordinal.get(base) ?? 0) + 1;
        ordinal.set(base, k);
        r.identity = `${base}|${k}`;
    }
    return r;
}

const SC_LETTERS: Record<string, string> = { "1": "A", "2": "B", "3": "C", "4": "E", "5": "M" };
const SC_KINDS: Record<string, string> = { "1": "F", "2": "R", "3": "C", "4": "D" };

/** Importe con signo de Santa Cruz: «-00000000525,62», «00000000-525,62» o positivo. */
function signedSantaCruzAmount(raw: string): Prisma.Decimal | null {
    const s = raw.trim();
    const m = /^(-?)(\d*)(-?)(\d+,\d{2})$/.exec(s);
    if (!m || (m[1] && m[3]) || (m[3] && /[1-9]/.test(m[2]))) return null;
    const v = new Prisma.Decimal((m[2] + m[4]).replace(",", "."));
    return m[1] || m[3] ? v.negated() : v;
}

function santaCruzPercepcion(line: string, n: number, ordinal: Map<string, number>): IibbImportRow {
    const r = blankRow(n, "SANTA_CRUZ_PERCEPCIONES");
    r.date = dmy(line.slice(0, 10));
    if (!r.date) raise(r, "ERROR", "fecha inválida (dd/mm/aaaa)");
    checkCuit(r, line.slice(10, 21));
    const c22 = line[21], c23 = line[22];
    const number = line.slice(23, 38).trim();
    const amount = signedSantaCruzAmount(line.slice(38, 53));
    if (SC_LETTERS[c22] && /^[1-5]$/.test(c23) && /^\d{4}-\d{8}$/.test(number)) {
        // Variante codificada del F.5680.
        r.voucherLetter = SC_LETTERS[c22];
        r.voucherKind = SC_KINDS[c23] ?? null;
        if (!r.voucherKind) raise(r, "REVIEW", "tipo de comprobante «Otros» (5): revisá a qué comprobante corresponde");
        r.pointOfSale = number.slice(0, 4);
        r.voucherNumber = number.slice(5);
    } else {
        // Variante de la descarga de ASIP: «1A» factura, «6A» nota de crédito, «F » factura.
        const kind = c22 === "1" || c22 === "F" ? "F" : c22 === "6" ? "C" : null;
        if (!kind) raise(r, "ERROR", `tipo de comprobante «${c22}» no reconocido en la descarga de ASIP`);
        r.voucherKind = kind;
        r.voucherLetter = c23 && "ABCEM".includes(c23) ? c23 : null;
        r.messages.push("la descarga de ASIP no trae el número de comprobante: se concilia con la compra por agente, fecha e importe");
    }
    if (r.voucherLetter === "E") {
        r.voucherLetter = null; // la tabla de la base no tiene «E» (exportación)
        r.messages.push("letra E: se registra sin letra");
    }
    if (amount === null) raise(r, "ERROR", "importe con formato inválido");
    else if (amount.isZero()) raise(r, "REVIEW", "importe en cero");
    else if (amount.isNegative() !== (r.voucherKind === "C")) raise(r, "ERROR", "el signo del importe no coincide con el tipo de comprobante (sólo las notas de crédito restan)");
    r.amount = amount;
    if (r.agentCuit && r.date && amount) {
        // Misma identidad para las dos variantes: importar ambas no duplica.
        const base = `PSC|${r.agentCuit}|${r.date}|${amount.toFixed(2)}`;
        const k = (ordinal.get(base) ?? 0) + 1;
        ordinal.set(base, k);
        r.identity = `${base}|${k}`;
    }
    return r;
}

// ── Rentas Ciudad (CSV) ────────────────────────────────────────────────────

function csvCells(line: string): string[] {
    const out: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
        } else if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
    }
    out.push(cur);
    // La descarga termina cada fila con coma: la última celda vacía sobra.
    if (out.length > 1 && out[out.length - 1] === "") out.pop();
    return out;
}

const norm = (h: string) => h.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();

function rentasCiudad(lines: string[], startLine: number): IibbImportParse {
    const header = csvCells(lines[0]).map(norm);
    const col = (name: string) => header.indexOf(norm(name));
    let format: IibbImportFormat | null = null;
    if (col("Fecha Percepcion") >= 0 && col("Monto Percibido") >= 0) format = "RENTAS_CIUDAD_PERCEPCIONES";
    else if (col("Fecha Retencion") >= 0 && col("Monto Retenido") >= 0) format = "RENTAS_CIUDAD_RETENCIONES";
    else if (col("importeRecaudadoPorJuris") >= 0 && col("CBU") >= 0) format = "RENTAS_CIUDAD_BANCARIAS";
    if (!format) return { format: null, rows: [], fileErrors: ["CSV de Rentas Ciudad con columnas no reconocidas"] };
    const rows: IibbImportRow[] = [];
    const ordinal = new Map<string, number>();
    lines.slice(1).forEach((l, i) => {
        const cells = csvCells(l);
        const get = (name: string) => (cells[col(name)] ?? "").trim();
        const r = blankRow(startLine + i + 1, format!);
        const amountOf = (v: string) => (/^\d+(\.\d{1,2})?$/.test(v) ? new Prisma.Decimal(v) : null);
        if (cells.length < header.length) raise(r, "ERROR", `fila incompleta (${cells.length} de ${header.length} columnas)`);
        if (format === "RENTAS_CIUDAD_BANCARIAS") {
            checkCuit(r, get("cuit"), "CUIT del banco");
            r.agentName = get("razonSocial") || null;
            r.date = dmy(get("fechaPresentacion"));
            if (!r.date) raise(r, "ERROR", "fecha inválida (dd/mm/aaaa)");
            const coef = get("coeficienteJurisdiccion");
            if (coef !== "1") raise(r, "REVIEW", `coeficiente de jurisdicción ${coef || "(vacío)"}: se toma el importe atribuido a CABA`);
            r.amount = needPositive(r, amountOf(get("importeRecaudadoPorJuris")), "importe recaudado por jurisdicción");
            checkCbu(r, get("CBU"));
            if (r.agentCuit && r.date && r.cbu && r.amount) r.identity = bankIdentity(ordinal, r.agentCuit, r.date, r.cbu, r.amount);
        } else {
            const perc = format === "RENTAS_CIUDAD_PERCEPCIONES";
            checkCuit(r, get("CUIT"));
            r.agentName = get("Razon Social") || null;
            r.date = dmy(get(perc ? "Fecha Percepcion" : "Fecha Retencion"));
            if (!r.date) raise(r, "ERROR", "fecha inválida (dd/mm/aaaa)");
            r.baseAmount = needPositive(r, amountOf(get("Base Calculo")), "base de cálculo");
            const amount = needPositive(r, amountOf(get(perc ? "Monto Percibido" : "Monto Retenido")), "importe");
            const cert = get("N° Certificado");
            if (cert && !/^0+$/.test(cert)) r.certificateNumber = cert;
            r.voucherKind = get("Tipo Comprobante") || null;
            const nro = get("N° Comprobante");
            r.voucherNumber = nro ? nro.replace(/\s+/g, " ") : null;
            if (perc) {
                // Observado: letra + número, p. ej. «A0   4170000488105».
                const m = /^([ABCMT])(.*)$/.exec(r.voucherNumber ?? "");
                if (m) { r.voucherLetter = m[1]; r.voucherNumber = m[2].replace(/\s+/g, ""); }
                if (!r.voucherKind || !"FRCD".includes(r.voucherKind)) raise(r, "REVIEW", `tipo de comprobante «${r.voucherKind ?? ""}» fuera de la tabla de AGIP (F, R, C, D)`);
            }
            r.amount = amount && r.voucherKind === "C" ? amount.negated() : amount;
            if (r.agentCuit && r.voucherNumber && r.date) {
                r.identity = perc ? perceptionIdentity(r.agentCuit, r.voucherKind, r.voucherNumber) : retentionIdentity(r.agentCuit, r.date, r.voucherNumber);
            }
        }
        rows.push(r);
    });
    return { format, rows, fileErrors: [] };
}

// ── Detección ──────────────────────────────────────────────────────────────

/**
 * Reconoce el formato por su estructura (no por el nombre del archivo) y lo
 * lee. Un archivo que no coincide con ningún formato conocido devuelve un
 * error de archivo, nunca filas a medias.
 */
export function parseIibbDeductions(bytes: Uint8Array): IibbImportParse {
    const text = decodeText(bytes);
    const all = text.split(/\r?\n/);
    let lines = all.map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.trim() !== "");
    if (lines.length === 0) return { format: null, rows: [], fileErrors: ["el archivo está vacío"] };
    if (lines.length > MAX_ROWS) return { format: null, rows: [], fileErrors: [`demasiadas filas (máximo ${MAX_ROWS})`] };

    // Rentas Ciudad: «sep=,» y encabezado.
    if (/^sep=,\s*$/i.test(lines[0].l)) lines = lines.slice(1);
    if (lines.length > 0 && /cuit/i.test(lines[0].l) && lines[0].l.includes(",")) {
        return rentasCiudad(lines.map((x) => x.l), lines[0].n);
    }

    const lengths = new Set(lines.map((x) => x.l.length));
    if (lengths.size !== 1) return { format: null, rows: [], fileErrors: ["los registros no tienen todos el mismo largo: no es un formato de ancho fijo conocido"] };
    const len = [...lengths][0];
    const first = lines[0].l;
    const ordinal = new Map<string, number>();
    let format: IibbImportFormat | null = null;
    let read: ((l: string, n: number) => IibbImportRow) | null = null;
    if (len === 65 && /^\d{11}/.test(first)) { format = "ESICOL_PERCEPCIONES"; read = esicolPercepcion; }
    else if (len === 59 && /^\d{19}/.test(first)) { format = "ESICOL_RETENCIONES"; read = esicolRetencion; }
    else if (len === 63 && /^\d{19}/.test(first)) { format = "ESICOL_BANCARIAS"; read = (l, n) => esicolBancaria(l, n, ordinal); }
    else if (len === 51 && /^\d{2}\/\d{2}\/\d{4}\d{11}/.test(first)) { format = "SANTA_CRUZ_RETENCIONES"; read = santaCruzRetencion; }
    else if (len === 53 && /^\d{2}\/\d{2}\/\d{4}\d{11}/.test(first)) { format = "SANTA_CRUZ_PERCEPCIONES"; read = (l, n) => santaCruzPercepcion(l, n, ordinal); }
    else if (len === 43 && /^\d{28}/.test(first)) { format = "SANTA_CRUZ_BANCARIAS"; read = (l, n) => santaCruzBancaria(l, n, ordinal); }
    if (!format || !read) return { format: null, rows: [], fileErrors: [`formato no reconocido (registros de ${len} caracteres)`] };
    return { format, rows: lines.map((x) => read!(x.l, x.n)), fileErrors: [] };
}
