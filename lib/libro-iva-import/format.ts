/**
 * Lectura de los archivos de importación del Libro IVA Digital (R.G. N° 4597).
 *
 * Fuente ÚNICA de las posiciones: "ANEXO I – DISEÑOS DE REGISTROS"
 * (SOURCE_LID_DISENO_REGISTROS) y las reglas generales de las
 * "Especificaciones", revisión 30/07/2025 (SOURCE_LID_ESPECIFICACIONES):
 *  - importes de 15 posiciones, 13 enteros y 2 decimales sin punto; si es
 *    negativo, "-" en la primera posición de los enteros;
 *  - tipo de cambio de 10 posiciones, 4 enteros y 6 decimales;
 *  - archivos ANSI (ISO 8859-1 / Windows-1252), un registro por línea.
 *
 * Este módulo sólo LEE y valida la forma técnica de cada registro. No decide
 * nada contable (lib/libro-iva-import/build.ts) ni accede a la base.
 */
import { Prisma } from "@prisma/client";

export type LidCategory = "SALES" | "PURCHASES";
export type LidFileKind = "VOUCHERS" | "ALIQUOTS";

/** Longitudes de registro del Anexo I. */
export const RECORD_LENGTH = {
    SALES_VOUCHERS: 266,
    SALES_TURIVA_VOUCHERS: 281,
    SALES_ALIQUOTS: 62,
    PURCHASES_VOUCHERS: 325,
    PURCHASES_TURIVA_VOUCHERS: 340,
    PURCHASES_ALIQUOTS: 84,
} as const;

type FieldKind = "date" | "int" | "text" | "amount" | "rate" | "char";
interface FieldSpec {
    name: string;
    from: number; // posición inicial (1-based, inclusiva)
    to: number; // posición final (1-based, inclusiva)
    kind: FieldKind;
}
const f = (name: string, from: number, to: number, kind: FieldKind): FieldSpec => ({ name, from, to, kind });

// Ventas - Cabecera (LIBRO_IVA_DIGITAL_VENTAS_CBTE, 266) y Ventas por TurIVA (281, campo 23).
const SALES_VOUCHER_FIELDS: readonly FieldSpec[] = [
    f("date", 1, 8, "date"),
    f("voucherCode", 9, 11, "int"),
    f("pointOfSale", 12, 16, "int"),
    f("number", 17, 36, "int"),
    f("numberTo", 37, 56, "int"),
    f("docType", 57, 58, "int"),
    f("docNumber", 59, 78, "text"),
    f("name", 79, 108, "text"),
    f("total", 109, 123, "amount"),
    f("nonTaxed", 124, 138, "amount"),
    f("vatPerception", 139, 153, "amount"), // Percepción a no categorizados
    f("exempt", 154, 168, "amount"),
    f("nationalPerception", 169, 183, "amount"),
    f("iibbPerception", 184, 198, "amount"),
    f("municipalPerception", 199, 213, "amount"),
    f("internalTaxes", 214, 228, "amount"),
    f("currency", 229, 231, "text"),
    f("exchangeRate", 232, 241, "rate"),
    f("aliquotCount", 242, 242, "int"),
    f("operationCode", 243, 243, "char"),
    f("otherTaxes", 244, 258, "amount"),
    f("dueDate", 259, 266, "text"),
];
const SALES_TURIVA_EXTRA: readonly FieldSpec[] = [f("turivaRefund", 267, 281, "amount")];

// Ventas - Alícuotas (LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS, 62).
const SALES_ALIQUOT_FIELDS: readonly FieldSpec[] = [
    f("voucherCode", 1, 3, "int"),
    f("pointOfSale", 4, 8, "int"),
    f("number", 9, 28, "int"),
    f("net", 29, 43, "amount"),
    f("rateCode", 44, 47, "int"),
    f("vat", 48, 62, "amount"),
];

// Compras e Importación de Bienes - Cabecera (325) y Compras por TurIVA (340, campo 26).
const PURCHASE_VOUCHER_FIELDS: readonly FieldSpec[] = [
    f("date", 1, 8, "date"),
    f("voucherCode", 9, 11, "int"),
    f("pointOfSale", 12, 16, "int"),
    f("number", 17, 36, "int"),
    f("customsDispatch", 37, 52, "text"),
    f("docType", 53, 54, "int"),
    f("docNumber", 55, 74, "text"),
    f("name", 75, 104, "text"),
    f("total", 105, 119, "amount"),
    f("nonTaxed", 120, 134, "amount"),
    f("exempt", 135, 149, "amount"),
    f("vatPerception", 150, 164, "amount"),
    f("nationalPerception", 165, 179, "amount"),
    f("iibbPerception", 180, 194, "amount"),
    f("municipalPerception", 195, 209, "amount"),
    f("internalTaxes", 210, 224, "amount"),
    f("currency", 225, 227, "text"),
    f("exchangeRate", 228, 237, "rate"),
    f("aliquotCount", 238, 238, "int"),
    f("operationCode", 239, 239, "char"),
    f("computableCredit", 240, 254, "amount"),
    f("otherTaxes", 255, 269, "amount"),
    f("brokerCuit", 270, 280, "int"),
    f("brokerName", 281, 310, "text"),
    f("commissionVat", 311, 325, "amount"),
];
const PURCHASE_TURIVA_EXTRA: readonly FieldSpec[] = [f("turivaRefund", 326, 340, "amount")];

// Compras - Alícuotas (LIBRO_IVA_DIGITAL_COMPRAS_ALICUOTAS, 84).
const PURCHASE_ALIQUOT_FIELDS: readonly FieldSpec[] = [
    f("voucherCode", 1, 3, "int"),
    f("pointOfSale", 4, 8, "int"),
    f("number", 9, 28, "int"),
    f("docType", 29, 30, "int"),
    f("docNumber", 31, 50, "text"),
    f("net", 51, 65, "amount"),
    f("rateCode", 66, 69, "int"),
    f("vat", 70, 84, "amount"),
];

/** Valor leído de un campo. Los numéricos enteros quedan como string de dígitos (pueden exceder Number). */
export type FieldValue = string | Prisma.Decimal;

export interface ParsedRecord {
    /** Número de línea (1-based) en el archivo. */
    line: number;
    values: Record<string, FieldValue>;
}

export interface ParseIssue {
    line: number;
    field?: string;
    message: string;
}

export interface ParsedFile {
    kind: LidFileKind;
    category: LidCategory;
    /** Sólo comprobantes: archivo de la pestaña TurIVA (registro de 281/340). */
    turiva: boolean;
    records: ParsedRecord[];
    /** Líneas con problemas de forma: no se leen sus campos. */
    issues: ParseIssue[];
}

/**
 * Decodifica un archivo ANSI. Windows-1252 es superconjunto práctico de
 * ISO 8859-1 para los caracteres imprimibles; un byte, un carácter: la
 * longitud del registro se mide en bytes del archivo original.
 */
export function decodeAnsi(bytes: Uint8Array): string {
    return new TextDecoder("windows-1252").decode(bytes);
}

/** Líneas del archivo: acepta CRLF o LF; ignora líneas vacías al final. */
export function splitLines(text: string): string[] {
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

function parseAmount(raw: string): Prisma.Decimal | null {
    // 15 posiciones: dígitos, o "-" en la primera posición y dígitos.
    if (!/^-?\d+$/.test(raw)) return null;
    return new Prisma.Decimal(raw).div(100);
}

function parseRate(raw: string): Prisma.Decimal | null {
    if (!/^\d+$/.test(raw)) return null;
    return new Prisma.Decimal(raw).div(1_000_000);
}

function isValidDate(raw: string): boolean {
    if (!/^\d{8}$/.test(raw)) return false;
    const y = Number(raw.slice(0, 4)), m = Number(raw.slice(4, 6)), d = Number(raw.slice(6, 8));
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function specFor(category: LidCategory, kind: LidFileKind, length: number): { fields: readonly FieldSpec[]; turiva: boolean } | null {
    if (kind === "ALIQUOTS") {
        if (category === "SALES" && length === RECORD_LENGTH.SALES_ALIQUOTS) return { fields: SALES_ALIQUOT_FIELDS, turiva: false };
        if (category === "PURCHASES" && length === RECORD_LENGTH.PURCHASES_ALIQUOTS) return { fields: PURCHASE_ALIQUOT_FIELDS, turiva: false };
        return null;
    }
    if (category === "SALES") {
        if (length === RECORD_LENGTH.SALES_VOUCHERS) return { fields: SALES_VOUCHER_FIELDS, turiva: false };
        if (length === RECORD_LENGTH.SALES_TURIVA_VOUCHERS) return { fields: [...SALES_VOUCHER_FIELDS, ...SALES_TURIVA_EXTRA], turiva: true };
        return null;
    }
    if (length === RECORD_LENGTH.PURCHASES_VOUCHERS) return { fields: PURCHASE_VOUCHER_FIELDS, turiva: false };
    if (length === RECORD_LENGTH.PURCHASES_TURIVA_VOUCHERS) return { fields: [...PURCHASE_VOUCHER_FIELDS, ...PURCHASE_TURIVA_EXTRA], turiva: true };
    return null;
}

function expectedLengths(category: LidCategory, kind: LidFileKind): string {
    if (kind === "ALIQUOTS") return String(category === "SALES" ? RECORD_LENGTH.SALES_ALIQUOTS : RECORD_LENGTH.PURCHASES_ALIQUOTS);
    return category === "SALES"
        ? `${RECORD_LENGTH.SALES_VOUCHERS} o ${RECORD_LENGTH.SALES_TURIVA_VOUCHERS} (TurIVA)`
        : `${RECORD_LENGTH.PURCHASES_VOUCHERS} o ${RECORD_LENGTH.PURCHASES_TURIVA_VOUCHERS} (TurIVA)`;
}

/**
 * Lee un archivo completo. Todas las líneas de un archivo de comprobantes
 * deben tener la misma longitud (o todas general, o todas TurIVA). Una línea
 * con longitud o campos inválidos se informa y no se lee.
 */
export function parseLidFile(bytes: Uint8Array, category: LidCategory, kind: LidFileKind): ParsedFile {
    const lines = splitLines(decodeAnsi(bytes));
    const issues: ParseIssue[] = [];
    const records: ParsedRecord[] = [];
    let turiva: boolean | null = null;

    lines.forEach((text, i) => {
        const line = i + 1;
        const spec = specFor(category, kind, text.length);
        if (!spec) {
            issues.push({
                line,
                message: `longitud ${text.length}: se esperaba ${expectedLengths(category, kind)} caracteres (revisar que sea el archivo correcto y esté en ANSI)`,
            });
            return;
        }
        if (turiva === null) turiva = spec.turiva;
        else if (turiva !== spec.turiva) {
            issues.push({ line, message: "el archivo mezcla registros generales y de TurIVA" });
            return;
        }
        const values: Record<string, FieldValue> = {};
        for (const field of spec.fields) {
            const raw = text.slice(field.from - 1, field.to);
            switch (field.kind) {
                case "date":
                    if (!isValidDate(raw)) {
                        issues.push({ line, field: field.name, message: "fecha inválida (AAAAMMDD)" });
                        return;
                    }
                    values[field.name] = raw;
                    break;
                case "int":
                    if (!/^\d+$/.test(raw)) {
                        issues.push({ line, field: field.name, message: "campo numérico con caracteres no numéricos" });
                        return;
                    }
                    values[field.name] = raw;
                    break;
                case "amount": {
                    const v = parseAmount(raw);
                    if (v === null) {
                        issues.push({ line, field: field.name, message: "importe inválido (13 enteros y 2 decimales sin punto)" });
                        return;
                    }
                    values[field.name] = v;
                    break;
                }
                case "rate": {
                    const v = parseRate(raw);
                    if (v === null) {
                        issues.push({ line, field: field.name, message: "tipo de cambio inválido (4 enteros y 6 decimales)" });
                        return;
                    }
                    values[field.name] = v;
                    break;
                }
                case "text":
                case "char":
                    values[field.name] = raw;
                    break;
            }
        }
        records.push({ line, values });
    });

    return { kind, category, turiva: turiva ?? false, records, issues };
}
