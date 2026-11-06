/**
 * Generador de archivos SINTÉTICOS del Libro IVA Digital para pruebas.
 * Escrito de forma independiente del lector (lib/libro-iva-import/format.ts):
 * cada campo se arma con su ancho del "Anexo I – Diseños de Registros" y se
 * verifica la longitud total del registro. Ningún dato es real.
 */

const num = (v: number | string, width: number) => {
    const s = String(v);
    if (!/^\d+$/.test(s) || s.length > width) throw new Error(`num inválido ${s}/${width}`);
    return s.padStart(width, "0");
};
const txt = (v: string, width: number) => {
    if (v.length > width) throw new Error(`txt largo ${v}/${width}`);
    return v.padEnd(width, " ");
};
/** Importe en pesos con centavos (string "1234.56" o número entero de centavos): 15 posiciones, "-" en la primera si es negativo. */
export const amt = (v: string, width = 15) => {
    const neg = v.startsWith("-");
    const [i, d = ""] = (neg ? v.slice(1) : v).split(".");
    const cents = `${i}${d.padEnd(2, "0").slice(0, 2)}`.replace(/^0+(?=\d)/, "");
    return neg ? "-" + cents.padStart(width - 1, "0") : cents.padStart(width, "0");
};

/**
 * CUIT sintético válido (dígito verificador oficial) a partir de 10 dígitos.
 * Si el módulo 11 da 10, ese prefijo no tiene dígito válido: lanza.
 */
export function cuit(prefix10: string): string {
    const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const s = prefix10.split("").reduce((a, c, i) => a + Number(c) * w[i], 0);
    const r = 11 - (s % 11);
    if (r === 10) throw new Error(`prefijo sin dígito verificador válido: ${prefix10}`);
    return prefix10 + String(r === 11 ? 0 : r);
}

/** El n-ésimo CUIT sintético válido a partir de un prefijo base (saltea los prefijos sin dígito). */
export function nthCuit(base: number, n: number): string {
    let found = -1;
    for (let p = base; ; p++) {
        try {
            const c = cuit(String(p));
            if (++found === n) return c;
        } catch {
            // prefijo sin dígito válido
        }
    }
}

export interface SynthVoucher {
    date: string; // AAAAMMDD
    code: number;
    pos: number;
    number: number;
    numberTo?: number;
    docType?: number;
    doc: string;
    name: string;
    total: string;
    nonTaxed?: string;
    exempt?: string;
    vatPerception?: string;
    nationalPerception?: string;
    iibbPerception?: string;
    municipalPerception?: string;
    internalTaxes?: string;
    otherTaxes?: string;
    currency?: string;
    exchangeRate?: string; // 10 dígitos (4 enteros + 6 decimales)
    aliquotCount: number;
    operationCode?: string;
    computableCredit?: string; // compras
    turivaRefund?: string; // sólo archivos TurIVA
    customsDispatch?: string;
    brokerCuit?: string;
    commissionVat?: string;
}
export interface SynthAliquot {
    code: number;
    pos: number;
    number: number;
    docType?: number;
    doc?: string;
    net: string;
    rate: number; // código oficial (5 = 21 %)
    vat: string;
}

const z = (v: string | undefined) => amt(v ?? "0");

export function salesVoucherLine(v: SynthVoucher, turiva = false): string {
    const parts = [
        num(v.date, 8), num(v.code, 3), num(v.pos, 5), num(v.number, 20), num(v.numberTo ?? v.number, 20),
        num(v.docType ?? 80, 2), num(v.doc, 20), txt(v.name, 30), amt(v.total), z(v.nonTaxed), z(v.vatPerception), z(v.exempt),
        z(v.nationalPerception), z(v.iibbPerception), z(v.municipalPerception), z(v.internalTaxes), txt(v.currency ?? "PES", 3),
        v.exchangeRate ?? "0001000000", num(v.aliquotCount, 1), txt(v.operationCode ?? " ", 1), z(v.otherTaxes), num("0", 8),
    ];
    if (turiva) parts.push(z(v.turivaRefund));
    const line = parts.join("");
    if (line.length !== (turiva ? 281 : 266)) throw new Error(`venta de longitud ${line.length}`);
    return line;
}

export function purchaseVoucherLine(v: SynthVoucher, turiva = false): string {
    const parts = [
        num(v.date, 8), num(v.code, 3), num(v.pos, 5), num(v.number, 20), txt(v.customsDispatch ?? "0".repeat(16), 16),
        num(v.docType ?? 80, 2), num(v.doc, 20), txt(v.name, 30), amt(v.total), z(v.nonTaxed), z(v.exempt), z(v.vatPerception),
        z(v.nationalPerception), z(v.iibbPerception), z(v.municipalPerception), z(v.internalTaxes), txt(v.currency ?? "PES", 3),
        v.exchangeRate ?? "0001000000", num(v.aliquotCount, 1), txt(v.operationCode ?? " ", 1), z(v.computableCredit), z(v.otherTaxes),
        num(v.brokerCuit ?? "0", 11), txt("", 30), z(v.commissionVat),
    ];
    if (turiva) parts.push(z(v.turivaRefund));
    const line = parts.join("");
    if (line.length !== (turiva ? 340 : 325)) throw new Error(`compra de longitud ${line.length}`);
    return line;
}

export function salesAliquotLine(a: SynthAliquot): string {
    const line = [num(a.code, 3), num(a.pos, 5), num(a.number, 20), amt(a.net), num(a.rate, 4), amt(a.vat)].join("");
    if (line.length !== 62) throw new Error(`alícuota de venta de longitud ${line.length}`);
    return line;
}

export function purchaseAliquotLine(a: SynthAliquot): string {
    const line = [num(a.code, 3), num(a.pos, 5), num(a.number, 20), num(a.docType ?? 80, 2), num(a.doc ?? "0", 20), amt(a.net), num(a.rate, 4), amt(a.vat)].join("");
    if (line.length !== 84) throw new Error(`alícuota de compra de longitud ${line.length}`);
    return line;
}

/** Archivo ANSI (Windows-1252, un byte por carácter) con CRLF, como lo exporta el Libro IVA Digital. */
export function ansiFile(lines: string[], eol = "\r\n"): Uint8Array {
    const text = lines.join(eol) + (lines.length ? eol : "");
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        // Sólo caracteres de un byte compatibles con ISO 8859-1 (sin los 0x80–0x9F de Windows-1252).
        if (c > 0xff || (c >= 0x80 && c < 0xa0)) throw new Error(`carácter fuera de ISO 8859-1: ${text[i]}`);
        out[i] = c;
    }
    return out;
}

// ── Descarga de Portal IVA (CSV ";" con decimal ",", Windows-1252) ─────────────

const PORTAL_SALES_HEADER = ["Fecha de Emisión", "Tipo de Comprobante", "Punto de Venta", "Número de Comprobante", "Número de Comprobante Hasta", "Tipo Doc. Comprador", "Nro. Doc. Comprador", "Denominación Comprador", "Fecha de Vencimiento del Pago", "Importe Total", "Moneda Original", "Tipo de Cambio", "Importe No Gravado", "Importe Exento", "Importe de Per. o Pagos a Cta. de Otros Imp. Nac.", "Importe de Percepciones de Ingresos Brutos", "Importe de Impuestos Municipales", "Percepción a No Categorizados", "Importe de Impuestos Internos", "Importe Otros Tributos", "Neto Gravado IVA 0%", "Neto Gravado IVA 2,5%", "Importe IVA 2,5%", "Neto Gravado IVA 5%", "Importe IVA 5%", "Neto Gravado IVA 10,5%", "Importe IVA 10,5%", "Neto Gravado IVA 21%", "Importe IVA 21%", "Neto Gravado IVA 27%", "Importe IVA 27%", "Total Neto Gravado", "Total IVA"];
const PORTAL_PURCHASES_HEADER = ["Fecha de Emisión", "Tipo de Comprobante", "Punto de Venta", "Número de Comprobante", "Tipo Doc. Vendedor", "Nro. Doc. Vendedor", "Denominación Vendedor", "Importe Total", "Moneda Original", "Tipo de Cambio", "Importe No Gravado", "Importe Exento", "Crédito Fiscal Computable", "Importe de Per. o Pagos a Cta. de Otros Imp. Nac.", "Importe de Percepciones de Ingresos Brutos", "Importe de Impuestos Municipales", "Importe de Percepciones o Pagos a Cuenta de IVA", "Importe de Impuestos Internos", "Importe Otros Tributos", "Neto Gravado IVA 0%", "Neto Gravado IVA 2,5%", "Importe IVA 2,5%", "Neto Gravado IVA 5%", "Importe IVA 5%", "Neto Gravado IVA 10,5%", "Importe IVA 10,5%", "Neto Gravado IVA 21%", "Importe IVA 21%", "Neto Gravado IVA 27%", "Importe IVA 27%", "Total Neto Gravado", "Total IVA"];

export interface SynthPortalRow {
    date: string; // AAAA-MM-DD
    code: number;
    pos: number;
    number: number;
    docType?: number;
    doc: string;
    name: string;
    /** Importes con el signo de la descarga (notas de crédito en negativo), "1234.56". */
    total: string;
    exempt?: string;
    nonTaxed?: string;
    vatPerception?: string;
    computableCredit?: string;
    /** Por alícuota: "21" | "10,5" | "0" ... -> [neto, IVA]. */
    rates?: Record<string, [string, string]>;
    totalVat?: string;
}

const c = (v: string | undefined) => (v === undefined ? "0,00" : v.replace(".", ","));

/** CSV de la descarga de comprobantes del período, en Windows-1252 con LF, como Portal IVA. */
export function portalCsv(category: "SALES" | "PURCHASES", rows: SynthPortalRow[], header?: string[]): Uint8Array {
    const h = header ?? (category === "SALES" ? PORTAL_SALES_HEADER : PORTAL_PURCHASES_HEADER);
    const lines = [h.map((x) => `"${x}"`).join(";")];
    for (const r of rows) {
        const rate = (p: string, i: 0 | 1) => (r.rates?.[p] ? c(r.rates[p][i]) : "");
        const rateCols = [rate("0", 0), rate("2,5", 0), rate("2,5", 1), rate("5", 0), rate("5", 1), rate("10,5", 0), rate("10,5", 1), rate("21", 0), rate("21", 1), rate("27", 0), rate("27", 1)];
        const nets = Object.values(r.rates ?? {}).reduce((s, x) => s + Number(x[0]), 0), vats = Object.values(r.rates ?? {}).reduce((s, x) => s + Number(x[1]), 0);
        const totals = r.rates ? [c(nets.toFixed(2)), c(r.totalVat ?? vats.toFixed(2))] : ["", ""];
        const head = category === "SALES"
            ? [r.date, r.code, r.pos, r.number, r.number, r.docType ?? 80, r.doc, `"${r.name}"`, r.date, c(r.total), `"PES"`, "1,00", c(r.nonTaxed), c(r.exempt), "0,00", "0,00", "0,00", c(r.vatPerception), "0,00", "0,00"]
            : [r.date, r.code, r.pos, r.number, r.docType ?? 80, r.doc, `"${r.name}"`, c(r.total), `"PES"`, "1,00", c(r.nonTaxed), c(r.exempt), c(r.computableCredit), "0,00", "0,00", "0,00", c(r.vatPerception), "0,00", "0,00"];
        lines.push([...head, ...rateCols, ...totals].join(";"));
    }
    return ansiFile(lines, "\n");
}

/** ZIP con una única entrada comprimida (deflate), como la descarga de Portal IVA. */
export function zipOne(name: string, data: Uint8Array, opts: { breakCrc?: boolean; extraEntry?: boolean } = {}): Uint8Array {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deflateRawSync } = require("node:zlib") as typeof import("node:zlib");
    let crc = 0xffffffff;
    for (const b of data) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    crc = ((crc ^ 0xffffffff) >>> 0) ^ (opts.breakCrc ? 1 : 0);
    const comp = new Uint8Array(deflateRawSync(data));
    const fname = new TextEncoder().encode(name);
    const entries = opts.extraEntry ? 2 : 1;
    const local = new Uint8Array(30 + fname.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 8, true); lv.setUint32(14, crc >>> 0, true);
    lv.setUint32(18, comp.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, fname.length, true); local.set(fname, 30);
    const cd = new Uint8Array(46 + fname.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, 8, true); cv.setUint32(16, crc >>> 0, true);
    cv.setUint32(20, comp.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, fname.length, true); cv.setUint32(42, 0, true); cd.set(fname, 46);
    const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries, true); ev.setUint16(10, entries, true); ev.setUint32(12, cd.length, true); ev.setUint32(16, local.length + comp.length, true);
    const out = new Uint8Array(local.length + comp.length + cd.length + eocd.length);
    out.set(local, 0); out.set(comp, local.length); out.set(cd, local.length + comp.length); out.set(eocd, local.length + comp.length + cd.length);
    return out;
}
