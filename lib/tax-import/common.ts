import { Prisma } from "@prisma/client";
import { cuitCheckDigit } from "../cuit";

/**
 * Piezas comunes de los lectores de retenciones y percepciones de IVA (lógica
 * pura). Fuente de los formatos: "F.2051 – Especificación de importaciones"
 * (https://www.arca.gob.ar/iva/documentos/F2051-IVA-especificacion-de-importaciones.pdf,
 * 12/11/2025): importes sin separador de miles con hasta 2 decimales, fechas
 * ISO, tabla de tipos de comprobante con su formato de número.
 */

export type ImportRowStatus = "OK" | "DUPLICATE" | "REVIEW" | "ERROR";
const RANK: Record<ImportRowStatus, number> = { OK: 0, DUPLICATE: 1, REVIEW: 2, ERROR: 3 };

export function raise(row: { status: ImportRowStatus; messages: string[] }, status: ImportRowStatus, message: string): void {
    row.messages.push(message);
    if (RANK[status] > RANK[row.status]) row.status = status;
}

export function validCuit(v: string): boolean {
    if (!/^\d{11}$/.test(v)) return false;
    const d = cuitCheckDigit(v.slice(0, 10));
    return d !== null && d === Number(v[10]);
}

export function validIsoDate(v: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCDate() === Number(m[3]) && d.getUTCMonth() === Number(m[2]) - 1;
}

/**
 * Importe positivo: "1234.56" (descargas observadas), "1234,56" (diseño
 * publicado) o "1234" (sin decimales). Un importe SIN separador es ambiguo en
 * las descargas observadas (¿pesos enteros o centavos implícitos?): se informa
 * con `integer: true` para que el llamador lo deje para revisar salvo
 * confirmación explícita del usuario.
 */
export function parseTaxAmount(raw: string): { value: Prisma.Decimal; integer: boolean } | null {
    const s = raw.trim();
    if (!/^\d{1,16}([.,]\d{1,2})?$/.test(s)) return null;
    const value = new Prisma.Decimal(s.replace(",", "."));
    if (value.isZero()) return null;
    return { value, integer: !/[.,]/.test(s) };
}

/**
 * Formato del número de comprobante por tipo, según la tabla del F.2051:
 * "99999-99999999" (factura, recibo, notas, liquidaciones…), 16 caracteres
 * (otro comprobante, escritura pública, factura de 16 dígitos), 12 (orden de
 * pago), "AA-BB-CCCCCCCC" (C.1116) y "33(01|02)" + 8 dígitos (liquidación
 * primaria de granos). Tipos fuera de la tabla: null.
 */
const DASHED_TYPES = new Set([1, 2, 3, 4, 17, 18, 19, 20, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
export function voucherNumberFormatOk(type: number, number: string): boolean | null {
    if (DASHED_TYPES.has(type)) return /^\d{5}-?\d{8}$/.test(number);
    if (type === 5 || type === 9 || type === 11) return /^[0-9A-Za-z]{16}$/.test(number);
    if (type === 6) return /^[0-9A-Za-z]{12}$/.test(number);
    if (type === 10) return /^[0-9A-Za-z]{2}-[0-9A-Za-z]{2}-[0-9A-Za-z]{8}$/.test(number);
    if (type === 45 || type === 46) return /^33(01|02)\d{8}$/.test(number);
    return null;
}

/** Texto plano (ASCII/UTF-8) en líneas no vacías, o error de archivo. */
export function textLines(bytes: Uint8Array, label: string, maxRows: number): { lines: string[] } | { error: string } {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch {
        return { error: `el archivo no es texto (ASCII/UTF-8) como la ${label}` };
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length === 0) return { error: "el archivo está vacío" };
    if (lines.length > maxRows) return { error: `demasiadas filas (máximo ${maxRows})` };
    if (/[A-Za-z]{3,}/.test(lines[0].split(";")[0] ?? "")) return { error: "la primera línea parece un encabezado: la descarga observada no lo trae (¿otro archivo?)" };
    return { lines };
}
