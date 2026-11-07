import "server-only";
import { Prisma } from "@prisma/client";

/**
 * Formatos de campo de los archivos para ARCA.
 *
 * Libro IVA Digital (Especificaciones, revisión 30/07/2025, "Consideraciones
 * generales"):
 *  - importes de 15 posiciones, 13 enteros y 2 decimales sin coma ni punto;
 *    si es negativo, "-" en la primera posición de los enteros;
 *  - numéricos con ceros a la izquierda, alfanuméricos con blancos a la derecha;
 *  - tipo de cambio de 10 posiciones, 4 enteros y 6 decimales;
 *  - archivos ANSI (ISO 8859-1 / Windows-1252).
 * CSV de IVA Simple y del F.2051: ";" como separador, "," decimal, sin
 * separador de miles, hasta 13 (apertura) o 16 (F.2051) enteros y 2 decimales.
 */

export class ExportFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExportFormatError";
    }
}

const AMOUNT_INT_DIGITS = 13;

/** Importe del Libro IVA Digital: 15 posiciones, centavos implícitos. */
export function lidAmount(value: Prisma.Decimal): string {
    if (value.decimalPlaces() > 2) throw new ExportFormatError(`importe con más de 2 decimales: ${value.toString()}`);
    const cents = value.times(100).abs().toFixed(0);
    if (value.isNegative() && !value.isZero()) {
        if (cents.length > 14) throw new ExportFormatError(`importe fuera del rango del diseño: ${value.toFixed(2)}`);
        return "-" + cents.padStart(14, "0");
    }
    if (cents.length > AMOUNT_INT_DIGITS + 2) throw new ExportFormatError(`importe fuera del rango del diseño: ${value.toFixed(2)}`);
    return cents.padStart(15, "0");
}

/** Tipo de cambio: 10 posiciones, 4 enteros y 6 decimales implícitos. */
export function lidExchangeRate(value: Prisma.Decimal): string {
    if (value.isNegative() || value.decimalPlaces() > 6) throw new ExportFormatError(`tipo de cambio inválido: ${value.toString()}`);
    const raw = value.times(1_000_000).toFixed(0);
    if (raw.length > 10) throw new ExportFormatError(`tipo de cambio fuera del rango del diseño: ${value.toString()}`);
    return raw.padStart(10, "0");
}

/** Numérico con ceros a la izquierda. */
export function lidNumber(value: number | string, width: number): string {
    const s = typeof value === "number" ? String(value) : value;
    if (!/^\d+$/.test(s)) throw new ExportFormatError(`valor numérico inválido: ${JSON.stringify(s)}`);
    if (s.length > width) throw new ExportFormatError(`valor ${s} excede ${width} posiciones`);
    return s.padStart(width, "0");
}

/**
 * Normalizaciones tipográficas seguras a ANSI (no cambian el contenido
 * identificatorio): comillas y guiones tipográficos, espacios especiales.
 */
const TYPOGRAPHIC: Record<string, string> = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"',
    "–": "-", "—": "-", "−": "-",
    " ": " ", " ": " ", " ": " ",
};

/** Texto representable en ISO 8859-1 (subconjunto común con Windows-1252), o null. */
export function toAnsiText(value: string): string | null {
    let out = "";
    for (const ch of value.normalize("NFC")) {
        const mapped = TYPOGRAPHIC[ch] ?? ch;
        const cp = mapped.codePointAt(0)!;
        if (mapped.length !== 1 || cp < 0x20 || (cp > 0x7e && cp < 0xa0) || cp > 0xff) return null;
        out += mapped;
    }
    return out;
}

/** Alfanumérico con blancos a la derecha; recorta a `width` (el diseño fija la longitud). */
export function lidText(value: string, width: number): string {
    const ansi = toAnsiText(value);
    if (ansi === null) throw new ExportFormatError(`texto con caracteres fuera de ANSI: ${JSON.stringify(value)}`);
    return ansi.slice(0, width).padEnd(width, " ");
}

/** Codifica texto ya validado como ANSI: un carácter, un byte (ISO 8859-1). */
export function encodeAnsi(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c > 0xff) throw new ExportFormatError("carácter fuera de ANSI al codificar");
        out[i] = c;
    }
    return out;
}

/** Fecha AAAA-MM-DD -> AAAAMMDD. */
export function lidDate(iso: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new ExportFormatError(`fecha inválida: ${iso}`);
    return iso.replaceAll("-", "");
}

/** Importe CSV con "," decimal, 2 decimales y sin separador de miles. */
export function csvAmount(value: Prisma.Decimal, maxIntDigits: number): string {
    if (value.isNegative()) throw new ExportFormatError(`importe negativo en un CSV que sólo admite positivos: ${value.toFixed(2)}`);
    if (value.decimalPlaces() > 2) throw new ExportFormatError(`importe con más de 2 decimales: ${value.toString()}`);
    const s = value.toFixed(2);
    const [int] = s.split(".");
    if (int.length > maxIntDigits) throw new ExportFormatError(`importe con más de ${maxIntDigits} enteros: ${s}`);
    return s.replace(".", ",");
}

/** Une líneas con CRLF (sin salto final, como las muestras de ARCA). */
export function crlfJoin(lines: string[]): string {
    return lines.join("\r\n");
}
