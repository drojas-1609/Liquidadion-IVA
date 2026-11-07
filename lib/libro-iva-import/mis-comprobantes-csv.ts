/**
 * Lectura de la consulta de **Mis Comprobantes** (ARCA → Mis Comprobantes →
 * Emitidos / Recibidos → «Exportar como CSV»):
 * `comprobantes_consulta_csv_{emitidos|recibidos}_<consulta>_<CUIT>_<fecha>.zip`,
 * con un único `… (montos expresados en pesos).csv`.
 *
 * ARCA no publica un diseño de registro de esta consulta. Las columnas son las
 * de la descarga observada el 06/11/2026 (consulta de octubre de 2026):
 *  - UTF-8 sin BOM, separador ";", encabezado entre comillas y salto LF;
 *  - fecha AAAA-MM-DD; importes con "," decimal y sin separador de miles;
 *  - notas de crédito con importes POSITIVOS (a diferencia de la descarga de
 *    Portal IVA): el signo contable sale sólo del código, como en el TXT;
 *  - por alícuota, neto e IVA en columnas separadas; «Otros Tributos» agrupado
 *    (puede incluir percepciones: no se separan ni se computan);
 *  - sin código de operación, crédito computable ni percepciones de IVA.
 * Si el encabezado no coincide EXACTAMENTE, el archivo se rechaza (nunca se
 * adivina una columna).
 *
 * Cada fila se convierte en un registro con los MISMOS campos que el lector del
 * Libro IVA Digital (format.ts), para reutilizar build.ts.
 */
import { Prisma } from "@prisma/client";
import { amount, csvRows, extractSingleCsv, isZip } from "./portal-csv";
import type { FieldValue, LidCategory, ParsedFile, ParsedRecord } from "./format";

const RATE_COLUMNS = [
    "Imp. Neto Gravado IVA 0%", "IVA 2,5%", "Imp. Neto Gravado IVA 2,5%", "IVA 5%", "Imp. Neto Gravado IVA 5%", "IVA 10,5%",
    "Imp. Neto Gravado IVA 10,5%", "IVA 21%", "Imp. Neto Gravado IVA 21%", "IVA 27%", "Imp. Neto Gravado IVA 27%",
] as const;
const TOTALS = ["Imp. Neto Gravado Total", "Imp. Neto No Gravado", "Imp. Op. Exentas", "Otros Tributos", "Total IVA", "Imp. Total"] as const;

/** Encabezados exactos de la consulta (emitidos = ventas; recibidos = compras). */
export const MIS_COMPROBANTES_HEADERS: Record<LidCategory, readonly string[]> = {
    SALES: [
        "Fecha de Emisión", "Tipo de Comprobante", "Punto de Venta", "Número Desde", "Número Hasta", "Cód. Autorización",
        "Tipo Doc. Receptor", "Nro. Doc. Receptor", "Denominación Receptor", "Tipo Cambio", "Moneda", ...RATE_COLUMNS, ...TOTALS,
    ],
    PURCHASES: [
        "Fecha de Emisión", "Tipo de Comprobante", "Punto de Venta", "Número Desde", "Número Hasta", "Cód. Autorización",
        "Tipo Doc. Emisor", "Nro. Doc. Emisor", "Denominación Emisor", "Tipo Doc. Receptor", "Nro. Doc. Receptor", "Tipo Cambio", "Moneda",
        ...RATE_COLUMNS, ...TOTALS,
    ],
};

const RATES: readonly { code: number; net: string; vat: string | null }[] = [
    { code: 3, net: "Imp. Neto Gravado IVA 0%", vat: null },
    { code: 9, net: "Imp. Neto Gravado IVA 2,5%", vat: "IVA 2,5%" },
    { code: 8, net: "Imp. Neto Gravado IVA 5%", vat: "IVA 5%" },
    { code: 4, net: "Imp. Neto Gravado IVA 10,5%", vat: "IVA 10,5%" },
    { code: 5, net: "Imp. Neto Gravado IVA 21%", vat: "IVA 21%" },
    { code: 6, net: "Imp. Neto Gravado IVA 27%", vat: "IVA 27%" },
];

/** Moneda de la consulta: "$" son pesos. */
const PESOS_SYMBOL = "$";

export interface MisComprobantesParse {
    vouchers: ParsedFile;
    aliquots: ParsedFile;
    /** Notas por línea (totales que no cierran, «Otros Tributos» informados). */
    rowNotes: Map<number, string[]>;
    innerName: string | null;
    fileErrors: string[];
}

function decodeUtf8(bytes: Uint8Array): string | null {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch {
        return null;
    }
}

/**
 * @param clientCuit CUIT del cliente del período (sólo dígitos). En los
 *   recibidos, el receptor de cada comprobante debe ser el cliente: si no, la
 *   fila tiene error (el archivo es de otro contribuyente).
 */
export function parseMisComprobantes(input: Uint8Array, category: LidCategory, clientCuit: string | null): MisComprobantesParse {
    const vouchers: ParsedFile = { kind: "VOUCHERS", category, turiva: false, records: [], issues: [] };
    const aliquots: ParsedFile = { kind: "ALIQUOTS", category, turiva: false, records: [], issues: [] };
    const rowNotes = new Map<number, string[]>();
    const fileError = (message: string): MisComprobantesParse => ({ vouchers, aliquots, rowNotes, innerName: null, fileErrors: [message] });
    let bytes = input, innerName: string | null = null;
    if (isZip(input)) {
        const z = extractSingleCsv(input);
        if (!z.ok) return fileError(z.error);
        bytes = z.bytes;
        innerName = z.name;
    }
    const text = decodeUtf8(bytes);
    if (text === null) return fileError("el archivo no está en UTF-8 como la consulta de Mis Comprobantes");
    const rows = csvRows(text);
    if (rows.length === 0) return fileError("el archivo está vacío");
    const header = rows[0].map((h) => h.trim());
    const expected = MIS_COMPROBANTES_HEADERS[category];
    if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
        const other = MIS_COMPROBANTES_HEADERS[category === "SALES" ? "PURCHASES" : "SALES"];
        const swapped = header.length === other.length && header.every((h, i) => h === other[i]);
        return fileError(swapped
            ? `el archivo es de comprobantes ${category === "SALES" ? "recibidos (compras)" : "emitidos (ventas)"}: elegí el libro correcto`
            : "el encabezado no coincide con la consulta de Mis Comprobantes (¿otro archivo o cambió el formato?)");
    }
    const col = (name: string) => header.indexOf(name);

    rows.slice(1).forEach((r, k) => {
        const line = k + 2;
        const issue = (message: string, field?: string) => { vouchers.issues.push({ line, field, message }); };
        if (r.length !== expected.length) return issue(`la fila tiene ${r.length} columnas y el encabezado ${expected.length}`);
        const get = (name: string) => (r[col(name)] ?? "").trim();
        const date = get("Fecha de Emisión");
        const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
        const dt = dm ? new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]))) : null;
        if (!dm || !dt || dt.getUTCDate() !== Number(dm[3]) || dt.getUTCMonth() !== Number(dm[2]) - 1) return issue("fecha inválida (AAAA-MM-DD)", "date");

        const counterpartType = category === "SALES" ? "Tipo Doc. Receptor" : "Tipo Doc. Emisor";
        const counterpartNumber = category === "SALES" ? "Nro. Doc. Receptor" : "Nro. Doc. Emisor";
        const ints: Record<string, string> = {};
        for (const [key, name] of [["voucherCode", "Tipo de Comprobante"], ["pointOfSale", "Punto de Venta"], ["number", "Número Desde"], ["numberTo", "Número Hasta"], ["docType", counterpartType]] as const) {
            const v = get(name);
            if (!/^\d+$/.test(v)) return issue(`${name}: debe ser numérico`, key);
            ints[key] = v;
        }
        if (category === "PURCHASES" && clientCuit !== null) {
            const receptor = get("Nro. Doc. Receptor");
            if (receptor !== "" && receptor !== clientCuit) return issue("el receptor del comprobante no es el cliente del período: la consulta es de otro contribuyente", "receptor");
            if (receptor === "") rowNotes.set(line, [...(rowNotes.get(line) ?? []), "la consulta no informa el receptor de este comprobante"]);
        }
        const moneda = get("Moneda");
        const values: Record<string, FieldValue> = {
            ...ints,
            date: date.replace(/-/g, ""),
            docNumber: get(counterpartNumber),
            name: get(category === "SALES" ? "Denominación Receptor" : "Denominación Emisor"),
            // La consulta informa "$" para pesos; otro símbolo se conserva y queda para revisión.
            currency: moneda === PESOS_SYMBOL ? "PES" : moneda || "?",
            operationCode: " ",
            customsDispatch: "",
            brokerCuit: "0",
        };
        const amountCols: [string, string, boolean][] = [
            ["total", "Imp. Total", true], ["nonTaxed", "Imp. Neto No Gravado", false], ["exempt", "Imp. Op. Exentas", false],
            ["otherTaxes", "Otros Tributos", false], ["exchangeRate", "Tipo Cambio", true],
        ];
        for (const [key, name, required] of amountCols) {
            const v = amount(get(name));
            if (v === undefined || (required && v === null)) return issue(`${name}: importe inválido`, key);
            values[key] = v ?? new Prisma.Decimal(0);
        }
        // Percepciones: la consulta no las separa (quedan dentro de «Otros Tributos»).
        for (const key of ["vatPerception", "nationalPerception", "iibbPerception", "municipalPerception", "internalTaxes"]) values[key] = new Prisma.Decimal(0);
        if (!(values.otherTaxes as Prisma.Decimal).isZero()) {
            rowNotes.set(line, [...(rowNotes.get(line) ?? []), "«Otros Tributos» informados: pueden incluir percepciones, que no se separan ni se computan; registrarlas como retención/percepción"]);
        }

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
        // Sin crédito computable en la consulta: build.ts lo exige igual al IVA sólo sin prorrateo.
        if (category === "PURCHASES") values.computableCredit = vatSum;
        const totNet = amount(get("Imp. Neto Gravado Total")), totVat = amount(get("Total IVA"));
        const notes: string[] = [];
        if (totVat && !totVat.equals(vatSum)) notes.push(`«Total IVA» de la consulta ${totVat.toFixed(2)} difiere de la suma por alícuota ${vatSum.toFixed(2)}: se usa la suma por alícuota`);
        if (totNet && !totNet.equals(netSum)) notes.push(`«Imp. Neto Gravado Total» de la consulta ${totNet.toFixed(2)} difiere de la suma por alícuota ${netSum.toFixed(2)}: se usa la suma por alícuota`);
        if (notes.length) rowNotes.set(line, [...(rowNotes.get(line) ?? []), ...notes]);
        vouchers.records.push({ line, values });
        aliquots.records.push(...lines);
    });
    return { vouchers, aliquots, rowNotes, innerName, fileErrors: [] };
}
