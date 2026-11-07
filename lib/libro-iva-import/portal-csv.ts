/**
 * Lectura de la DESCARGA de comprobantes del período de Portal IVA
 * (`comprobantes_periodo_AAAAMM_{ventas|compras}_… (montos expresados en pesos).csv`,
 * normalmente dentro de un .zip del mismo nombre).
 *
 * ARCA no publica un diseño de registro de esta descarga. Las reglas generales
 * salen de las novedades oficiales del 19/11/2020
 * (https://arca.gob.ar/iva/sujetos-exentos/novedades.asp): .csv de detalle,
 * separador ";", decimal ",", importes en pesos y notas de crédito con
 * importes NEGATIVOS. Las columnas son las de la descarga observada en
 * noviembre de 2026; si cambian, el encabezado no coincide y el archivo se
 * rechaza (nunca se adivina una columna).
 *
 * Cada fila se convierte en un registro de comprobante con los MISMOS campos
 * que el lector del Libro IVA Digital (format.ts) y sus importes por alícuota
 * en registros de alícuotas, para reutilizar build.ts. Los importes quedan con
 * el signo del archivo: build.ts verifica que coincida con el tipo de
 * comprobante y usa el valor absoluto (el signo contable sale sólo del código).
 */
import { Prisma } from "@prisma/client";
import { inflateRawSync } from "node:zlib";
import { MAX_FILE_BYTES } from "./request";
import type { FieldValue, LidCategory, ParsedFile, ParsedRecord } from "./format";

const COMMON_AMOUNTS = [
    "Importe Total", "Moneda Original", "Tipo de Cambio", "Importe No Gravado", "Importe Exento",
] as const;
const RATE_COLUMNS = [
    "Neto Gravado IVA 0%", "Neto Gravado IVA 2,5%", "Importe IVA 2,5%", "Neto Gravado IVA 5%", "Importe IVA 5%",
    "Neto Gravado IVA 10,5%", "Importe IVA 10,5%", "Neto Gravado IVA 21%", "Importe IVA 21%", "Neto Gravado IVA 27%", "Importe IVA 27%",
    "Total Neto Gravado", "Total IVA",
] as const;

/** Encabezados exactos de la descarga (decodificados en Windows-1252). */
export const PORTAL_HEADERS: Record<LidCategory, readonly string[]> = {
    SALES: [
        "Fecha de Emisión", "Tipo de Comprobante", "Punto de Venta", "Número de Comprobante", "Número de Comprobante Hasta",
        "Tipo Doc. Comprador", "Nro. Doc. Comprador", "Denominación Comprador", "Fecha de Vencimiento del Pago", ...COMMON_AMOUNTS,
        "Importe de Per. o Pagos a Cta. de Otros Imp. Nac.", "Importe de Percepciones de Ingresos Brutos", "Importe de Impuestos Municipales",
        "Percepción a No Categorizados", "Importe de Impuestos Internos", "Importe Otros Tributos", ...RATE_COLUMNS,
    ],
    PURCHASES: [
        "Fecha de Emisión", "Tipo de Comprobante", "Punto de Venta", "Número de Comprobante", "Tipo Doc. Vendedor", "Nro. Doc. Vendedor",
        "Denominación Vendedor", ...COMMON_AMOUNTS, "Crédito Fiscal Computable", "Importe de Per. o Pagos a Cta. de Otros Imp. Nac.",
        "Importe de Percepciones de Ingresos Brutos", "Importe de Impuestos Municipales", "Importe de Percepciones o Pagos a Cuenta de IVA",
        "Importe de Impuestos Internos", "Importe Otros Tributos", ...RATE_COLUMNS,
    ],
};

/** Columnas por alícuota -> código oficial (Tablas del Sistema). */
const RATES: readonly { code: number; net: string; vat: string | null }[] = [
    { code: 3, net: "Neto Gravado IVA 0%", vat: null },
    { code: 9, net: "Neto Gravado IVA 2,5%", vat: "Importe IVA 2,5%" },
    { code: 8, net: "Neto Gravado IVA 5%", vat: "Importe IVA 5%" },
    { code: 4, net: "Neto Gravado IVA 10,5%", vat: "Importe IVA 10,5%" },
    { code: 5, net: "Neto Gravado IVA 21%", vat: "Importe IVA 21%" },
    { code: 6, net: "Neto Gravado IVA 27%", vat: "Importe IVA 27%" },
];

// ── ZIP mínimo: una sola entrada .csv, stored o deflate, con CRC ─────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(b: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Extrae el único .csv del ZIP de Portal IVA o explica por qué no. */
export function extractSingleCsv(zip: Uint8Array): { ok: true; name: string; bytes: Uint8Array } | { ok: false; error: string } {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { ok: false, error: "ZIP inválido" };
    const entries = view.getUint16(eocd + 10, true);
    if (entries !== 1) return { ok: false, error: `el ZIP debe contener un único archivo .csv (contiene ${entries})` };
    const cd = view.getUint32(eocd + 16, true);
    if (cd + 46 > zip.length || view.getUint32(cd, true) !== 0x02014b50) return { ok: false, error: "ZIP inválido" };
    const flags = view.getUint16(cd + 8, true), method = view.getUint16(cd + 10, true), crc = view.getUint32(cd + 16, true);
    const csize = view.getUint32(cd + 20, true), usize = view.getUint32(cd + 24, true);
    const nameLen = view.getUint16(cd + 28, true), local = view.getUint32(cd + 42, true);
    const name = new TextDecoder("windows-1252").decode(zip.subarray(cd + 46, cd + 46 + nameLen));
    if (flags & 1) return { ok: false, error: "ZIP cifrado: no admitido" };
    if (!/\.csv$/i.test(name) || /[\\/]/.test(name)) return { ok: false, error: "el ZIP debe contener un único archivo .csv" };
    if (usize > MAX_FILE_BYTES) return { ok: false, error: "el .csv del ZIP supera 2 MB" };
    if (local + 30 > zip.length || view.getUint32(local, true) !== 0x04034b50) return { ok: false, error: "ZIP inválido" };
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + csize > zip.length) return { ok: false, error: "ZIP incompleto" };
    const data = zip.subarray(start, start + csize);
    let out: Uint8Array;
    try {
        if (method === 0) out = data;
        else if (method === 8) out = new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_FILE_BYTES }));
        else return { ok: false, error: "método de compresión no admitido" };
    } catch {
        return { ok: false, error: "no se pudo descomprimir el ZIP (o el .csv supera 2 MB)" };
    }
    if (out.length !== usize || crc32(out) !== crc) return { ok: false, error: "ZIP dañado (CRC o tamaño no coinciden)" };
    return { ok: true, name, bytes: out };
}

// ── CSV ";" con comillas ─────────────────────────────────────────────────────

export function csvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], field = "", quoted = false, inQuotes = false;
    const push = () => { row.push(field); field = ""; quoted = false; };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
            } else field += c;
        } else if (c === '"' && field === "" && !quoted) { inQuotes = true; quoted = true; }
        else if (c === ";") push();
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            push(); rows.push(row); row = [];
        } else field += c;
    }
    if (field !== "" || row.length > 0) { push(); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** "1234,56", "-1234,56" o vacío (null). Sin separador de miles. */
export function amount(raw: string): Prisma.Decimal | null | undefined {
    const s = raw.trim();
    if (s === "") return null;
    if (!/^-?\d+(,\d{1,6})?$/.test(s)) return undefined;
    return new Prisma.Decimal(s.replace(",", "."));
}

export interface PortalParse {
    vouchers: ParsedFile;
    aliquots: ParsedFile;
    /** Diferencias entre «Total IVA» / «Total Neto Gravado» de la descarga y la suma de sus columnas por alícuota, por línea. */
    totalColumnNotes: Map<number, string[]>;
    /** Archivo extraído del ZIP (si vino comprimido). */
    innerName: string | null;
    /** Problemas del archivo completo (ZIP, encabezado): impiden confirmar. */
    fileErrors: string[];
}

/**
 * Lee la descarga (CSV o ZIP con un CSV). Los problemas del archivo (ZIP,
 * encabezado) van en `fileErrors`; los de una fila, en `vouchers.issues`
 * (build.ts los muestra como fila con error).
 */
export function parsePortalDownload(input: Uint8Array, category: LidCategory): PortalParse {
    const vouchers: ParsedFile = { kind: "VOUCHERS", category, turiva: false, records: [], issues: [] };
    const aliquots: ParsedFile = { kind: "ALIQUOTS", category, turiva: false, records: [], issues: [] };
    const notes = new Map<number, string[]>();
    const fileError = (message: string): PortalParse => ({ vouchers, aliquots, totalColumnNotes: notes, innerName: null, fileErrors: [message] });
    let bytes = input, innerName: string | null = null;
    if (isZip(input)) {
        const z = extractSingleCsv(input);
        if (!z.ok) return fileError(z.error);
        bytes = z.bytes;
        innerName = z.name;
    }
    const rows = csvRows(new TextDecoder("windows-1252").decode(bytes));
    if (rows.length === 0) return fileError("el archivo está vacío");
    const header = rows[0].map((h) => h.trim());
    const expected = PORTAL_HEADERS[category];
    if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
        const other = PORTAL_HEADERS[category === "SALES" ? "PURCHASES" : "SALES"];
        const swapped = header.length === other.length && header.every((h, i) => h === other[i]);
        return fileError(swapped
            ? `el archivo es de ${category === "SALES" ? "compras" : "ventas"}: elegí el libro correcto`
            : "el encabezado no coincide con la descarga de comprobantes de Portal IVA (¿otro archivo o cambió el formato?)");
    }
    const col = (name: string) => header.indexOf(name);

    rows.slice(1).forEach((r, k) => {
        const line = k + 2;
        const issue = (message: string, field?: string) => { vouchers.issues.push({ line, field, message }); };
        if (r.length !== expected.length) return issue(`la fila tiene ${r.length} columnas y el encabezado ${expected.length}`);
        const get = (name: string) => r[col(name)] ?? "";
        const date = get("Fecha de Emisión").trim();
        const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
        const dt = dm ? new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]))) : null;
        if (!dm || !dt || dt.getUTCDate() !== Number(dm[3]) || dt.getUTCMonth() !== Number(dm[2]) - 1) return issue("fecha inválida (AAAA-MM-DD)", "date");
        const ints: Record<string, string> = {};
        const intCols: [string, string][] = [["voucherCode", "Tipo de Comprobante"], ["pointOfSale", "Punto de Venta"], ["number", "Número de Comprobante"],
            ["docType", category === "SALES" ? "Tipo Doc. Comprador" : "Tipo Doc. Vendedor"]];
        if (category === "SALES") intCols.push(["numberTo", "Número de Comprobante Hasta"]);
        for (const [key, name] of intCols) {
            const v = get(name).trim();
            if (!/^\d+$/.test(v)) return issue(`${name}: debe ser numérico`, key);
            ints[key] = v;
        }
        const values: Record<string, FieldValue> = {
            ...ints,
            date: date.replace(/-/g, ""),
            docNumber: get(category === "SALES" ? "Nro. Doc. Comprador" : "Nro. Doc. Vendedor").trim(),
            name: get(category === "SALES" ? "Denominación Comprador" : "Denominación Vendedor").trim(),
            currency: get("Moneda Original").trim(),
            operationCode: " ",
            customsDispatch: "",
            brokerCuit: "0",
        };
        if (category === "PURCHASES") values.numberTo = ints.number;
        const amountCols: [string, string, boolean][] = [
            ["total", "Importe Total", true], ["nonTaxed", "Importe No Gravado", false], ["exempt", "Importe Exento", false],
            ["nationalPerception", "Importe de Per. o Pagos a Cta. de Otros Imp. Nac.", false],
            ["iibbPerception", "Importe de Percepciones de Ingresos Brutos", false], ["municipalPerception", "Importe de Impuestos Municipales", false],
            ["internalTaxes", "Importe de Impuestos Internos", false], ["otherTaxes", "Importe Otros Tributos", false],
            ["vatPerception", category === "SALES" ? "Percepción a No Categorizados" : "Importe de Percepciones o Pagos a Cuenta de IVA", false],
            ["exchangeRate", "Tipo de Cambio", true],
        ];
        if (category === "PURCHASES") amountCols.push(["computableCredit", "Crédito Fiscal Computable", false]);
        for (const [key, name, required] of amountCols) {
            const v = amount(get(name));
            if (v === undefined || (required && v === null)) return issue(`${name}: importe inválido`, key);
            values[key] = v ?? new Prisma.Decimal(0);
        }
        // Alícuotas: una por columna con importe distinto de cero.
        const lines: ParsedRecord[] = [];
        let netSum = new Prisma.Decimal(0), vatSum = new Prisma.Decimal(0);
        for (const rt of RATES) {
            const net = amount(get(rt.net)), vat = rt.vat ? amount(get(rt.vat)) : new Prisma.Decimal(0);
            if (net === undefined || vat === undefined) return issue(`${rt.net}: importe inválido`, "rates");
            const n = net ?? new Prisma.Decimal(0), v = vat ?? new Prisma.Decimal(0);
            if (n.isZero() && v.isZero()) continue;
            netSum = netSum.plus(n);
            vatSum = vatSum.plus(v);
            lines.push({
                line,
                values: { voucherCode: ints.voucherCode, pointOfSale: ints.pointOfSale, number: ints.number, docType: ints.docType,
                    docNumber: values.docNumber, net: n, rateCode: String(rt.code), vat: v },
            });
        }
        values.aliquotCount = String(lines.length);
        const totNet = amount(get("Total Neto Gravado")), totVat = amount(get("Total IVA"));
        const lineNotes: string[] = [];
        if (totVat && !totVat.equals(vatSum)) lineNotes.push(`«Total IVA» de la descarga ${totVat.toFixed(2)} difiere de la suma por alícuota ${vatSum.toFixed(2)}: se usa la suma por alícuota`);
        if (totNet && !totNet.equals(netSum)) lineNotes.push(`«Total Neto Gravado» de la descarga ${totNet.toFixed(2)} difiere de la suma por alícuota ${netSum.toFixed(2)}: se usa la suma por alícuota`);
        if (lineNotes.length) notes.set(line, lineNotes);
        vouchers.records.push({ line, values });
        aliquots.records.push(...lines);
    });
    return { vouchers, aliquots, totalColumnNotes: notes, innerName, fileErrors: [] };
}
