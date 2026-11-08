import "server-only";
import { Prisma } from "@prisma/client";
import { VOUCHER_LIQUIDACIONES_A, VOUCHER_TYPES } from "../arca/catalogs";
import { purchaseHasNoVatBreakdown } from "../invoice-model";
import { needsZeroRateRecord } from "./classification";
import { ExportFormatError, encodeAnsi, lidAmount, lidDate, lidExchangeRate, lidNumber, lidText } from "./text";
import type { ExportFile, ExportInvoice, ExportSettings, OmittedFile } from "./types";

/**
 * Archivos de importación del Libro IVA Digital (R.G. N° 4597) generados desde
 * los comprobantes del período. Posiciones: "ANEXO I – DISEÑOS DE REGISTROS"
 * (sha256 d8ea46d0…ba1571, verificado el 06/11/2026: sin cambios desde el
 * 03/11/2026) y reglas de las Especificaciones, revisión 30/07/2025:
 *  - Ventas cabecera 266 (TurIVA 281), Ventas alícuotas 62;
 *  - Compras cabecera 325 (TurIVA 340), Compras alícuotas 84;
 *  - mismo orden de comprobantes en cabecera y alícuotas;
 *  - importes siempre POSITIVOS (las notas de crédito se identifican por el
 *    tipo de comprobante; el modelo ya guarda valores absolutos);
 *  - cantidad de alícuotas 0 para compras B y C (no discriminan IVA);
 *  - código de operación sólo con alícuota 0 (si no, "0" = no corresponde);
 *  - crédito fiscal computable (compras, campo 21): igual al IVA liquidado sin
 *    prorrateo; el computable por comprobante con asignación directa; ceros con
 *    prorrateo global;
 *  - despacho: ceros (importaciones no se modelan en esta etapa);
 *  - CUIT y denominación del emisor/corredor e IVA comisión: ceros / blancos,
 *    salvo el 063 sin intermediario (CUIT y denominación del informante);
 *  - fecha de vencimiento de pago (ventas): ceros (sólo obligatoria en 017/018).
 * El archivo se codifica en ISO 8859-1 con un registro por línea (CRLF).
 */

export const LID_FILE_NAMES = {
    SALES_GENERAL_VOUCHERS: "LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt",
    SALES_GENERAL_ALIQUOTS: "LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS.txt",
    SALES_TURIVA_VOUCHERS: "LIBRO_IVA_DIGITAL_VENTAS_TURIVA_CBTE.txt",
    SALES_TURIVA_ALIQUOTS: "LIBRO_IVA_DIGITAL_VENTAS_TURIVA_ALICUOTAS.txt",
    PURCHASES_GENERAL_VOUCHERS: "LIBRO_IVA_DIGITAL_COMPRAS_CBTE.txt",
    PURCHASES_GENERAL_ALIQUOTS: "LIBRO_IVA_DIGITAL_COMPRAS_ALICUOTAS.txt",
    PURCHASES_TURIVA_VOUCHERS: "LIBRO_IVA_DIGITAL_COMPRAS_TURIVA_CBTE.txt",
    PURCHASES_TURIVA_ALIQUOTS: "LIBRO_IVA_DIGITAL_COMPRAS_TURIVA_ALICUOTAS.txt",
} as const;

const ZERO = new Prisma.Decimal(0);
const z = (d: Prisma.Decimal | null) => d ?? ZERO;

interface AliquotRow {
    rateCode: number;
    net: Prisma.Decimal;
    vat: Prisma.Decimal;
}

/** Líneas por alícuota (unifica las atribuciones de una misma alícuota). */
export function aliquotRows(inv: ExportInvoice): AliquotRow[] {
    if (inv.voucherCode === null) return [];
    if (inv.category === "PURCHASES" && purchaseHasNoVatBreakdown("PURCHASES", inv.voucherCode)) return [];
    const letter = VOUCHER_TYPES.find((t) => t.code === inv.voucherCode)?.letter;
    if (inv.category === "SALES" && letter === "C") return [];
    const byRate = new Map<number, AliquotRow>();
    for (const l of inv.vatLines) {
        const cur = byRate.get(l.vatRateCode) ?? { rateCode: l.vatRateCode, net: ZERO, vat: ZERO };
        byRate.set(l.vatRateCode, { rateCode: l.vatRateCode, net: cur.net.plus(l.netAmount), vat: cur.vat.plus(l.vatAmount) });
    }
    const rows = [...byRate.values()].sort((a, b) => a.rateCode - b.rateCode);
    // Operación sin IVA (exenta / no gravada): un registro de alícuota 0003 con neto 0.
    if (rows.length === 0 && needsZeroRateRecord(inv)) rows.push({ rateCode: 3, net: ZERO, vat: ZERO });
    return rows;
}

function operationCodeField(inv: ExportInvoice, rows: AliquotRow[]): string {
    const zeroRate = rows.some((r) => r.rateCode === 3);
    if (!zeroRate) return "0";
    const c = (inv.operationCode ?? "").trim();
    if (c.length !== 1) throw new ExportFormatError("falta el código de operación de una operación al 0 %");
    return c;
}

/** Crédito computable del campo 21 según la modalidad del período. */
export function computableField(inv: ExportInvoice, settings: ExportSettings): Prisma.Decimal {
    switch (settings.creditProrationMode) {
        case "NONE":
            return z(inv.totalVatAmount);
        case "DIRECT":
        case "DIRECT_AND_GLOBAL":
            return z(inv.directComputableVatCreditAmount);
        case "GLOBAL":
            return ZERO;
        default:
            throw new ExportFormatError(`modalidad de prorrateo desconocida: ${settings.creditProrationMode}`);
    }
}

function docNumber(inv: ExportInvoice): string {
    const raw = inv.counterpartyDocNumber ?? "0";
    return lidNumber(/^\d+$/.test(raw) ? raw : "0", 20);
}

/** Orden único de los comprobantes en cabecera y alícuotas. */
export function lidOrder(a: ExportInvoice, b: ExportInvoice): number {
    return (
        (a.voucherDate ?? "").localeCompare(b.voucherDate ?? "") ||
        (a.voucherCode ?? 0) - (b.voucherCode ?? 0) ||
        a.pointOfSale - b.pointOfSale ||
        a.number - b.number ||
        (a.counterpartyDocNumber ?? "").localeCompare(b.counterpartyDocNumber ?? "") ||
        a.id.localeCompare(b.id)
    );
}

export function salesVoucherRecord(inv: ExportInvoice, rows: AliquotRow[], turiva: boolean): string {
    const rec =
        lidDate(inv.voucherDate!) +
        lidNumber(inv.voucherCode!, 3) +
        lidNumber(inv.pointOfSale, 5) +
        lidNumber(inv.number, 20) +
        lidNumber(inv.numberTo ?? inv.number, 20) +
        lidNumber(inv.counterpartyDocType ?? 99, 2) +
        docNumber(inv) +
        lidText(inv.counterpartyName ?? "", 30) +
        lidAmount(z(inv.voucherTotalAmount)) +
        lidAmount(z(inv.nonTaxedAmount)) +
        lidAmount(z(inv.vatPerceptionAmount)) + // percepción a no categorizados
        lidAmount(z(inv.exemptAmount)) +
        lidAmount(z(inv.nationalPerceptionAmount)) +
        lidAmount(z(inv.iibbPerceptionAmount)) +
        lidAmount(z(inv.municipalPerceptionAmount)) +
        lidAmount(z(inv.internalTaxesAmount)) +
        "PES" +
        lidExchangeRate(new Prisma.Decimal(1)) +
        lidNumber(rows.length, 1) +
        operationCodeField(inv, rows) +
        lidAmount(z(inv.otherTaxesAmount)) +
        "00000000" +
        (turiva ? lidAmount(z(inv.turivaRefundAmount)) : "");
    const expected = turiva ? 281 : 266;
    if (rec.length !== expected) throw new ExportFormatError(`registro de ventas de ${rec.length} posiciones (se esperaban ${expected})`);
    return rec;
}

export function salesAliquotRecord(inv: ExportInvoice, row: AliquotRow): string {
    const rec = lidNumber(inv.voucherCode!, 3) + lidNumber(inv.pointOfSale, 5) + lidNumber(inv.number, 20) + lidAmount(row.net) + lidNumber(row.rateCode, 4) + lidAmount(row.vat);
    if (rec.length !== 62) throw new ExportFormatError(`registro de alícuotas de ventas de ${rec.length} posiciones`);
    return rec;
}

/** Informante (el cliente del período): campo 23 del 063 sin intermediario. */
export interface LidInformant {
    cuit: string;
    name: string;
}

/**
 * Campos 23–25 (CUIT y denominación del emisor/corredor, IVA comisión).
 * Especificaciones, Libro Compras: se informan para 033, 058, 059, 060 y 063;
 * si no interviene un tercero, la CUIT del informante. La app sólo admite el
 * 063 sin intermediario (la importación deja para revisión los que traen
 * corredor o comisión): CUIT y denominación del informante, IVA comisión 0.
 * Para el resto: ceros / espacios.
 */
function brokerFields(inv: ExportInvoice, informant: LidInformant | undefined): string {
    if (inv.voucherCode !== VOUCHER_LIQUIDACIONES_A) return "0".repeat(11) + " ".repeat(30) + lidAmount(ZERO);
    const digits = (informant?.cuit ?? "").replace(/\D/g, "");
    if (!informant || digits.length !== 11) throw new ExportFormatError("063 (Liquidaciones A): falta la CUIT del informante para el campo emisor/corredor");
    return digits + lidText(informant.name, 30) + lidAmount(ZERO);
}

export function purchaseVoucherRecord(inv: ExportInvoice, rows: AliquotRow[], settings: ExportSettings, turiva: boolean, informant?: LidInformant): string {
    const rec =
        lidDate(inv.voucherDate!) +
        lidNumber(inv.voucherCode!, 3) +
        lidNumber(inv.pointOfSale, 5) +
        lidNumber(inv.number, 20) +
        "0".repeat(16) + // despacho de importación
        lidNumber(inv.counterpartyDocType ?? 80, 2) +
        docNumber(inv) +
        lidText(inv.counterpartyName ?? "", 30) +
        lidAmount(z(inv.voucherTotalAmount)) +
        lidAmount(z(inv.nonTaxedAmount)) +
        lidAmount(z(inv.exemptAmount)) +
        lidAmount(z(inv.vatPerceptionAmount)) +
        lidAmount(z(inv.nationalPerceptionAmount)) +
        lidAmount(z(inv.iibbPerceptionAmount)) +
        lidAmount(z(inv.municipalPerceptionAmount)) +
        lidAmount(z(inv.internalTaxesAmount)) +
        "PES" +
        lidExchangeRate(new Prisma.Decimal(1)) +
        lidNumber(rows.length, 1) +
        operationCodeField(inv, rows) +
        lidAmount(computableField(inv, settings)) +
        lidAmount(z(inv.otherTaxesAmount)) +
        brokerFields(inv, informant) + // CUIT y denominación emisor / corredor, IVA comisión
        (turiva ? lidAmount(z(inv.turivaRefundAmount)) : "");
    const expected = turiva ? 340 : 325;
    if (rec.length !== expected) throw new ExportFormatError(`registro de compras de ${rec.length} posiciones (se esperaban ${expected})`);
    return rec;
}

export function purchaseAliquotRecord(inv: ExportInvoice, row: AliquotRow): string {
    const rec =
        lidNumber(inv.voucherCode!, 3) + lidNumber(inv.pointOfSale, 5) + lidNumber(inv.number, 20) +
        lidNumber(inv.counterpartyDocType ?? 80, 2) + docNumber(inv) +
        lidAmount(row.net) + lidNumber(row.rateCode, 4) + lidAmount(row.vat);
    if (rec.length !== 84) throw new ExportFormatError(`registro de alícuotas de compras de ${rec.length} posiciones`);
    return rec;
}

function file(name: string, lines: string[]): ExportFile {
    return { name, bytes: encodeAnsi(lines.length ? lines.join("\r\n") + "\r\n" : ""), records: lines.length };
}

export interface LidWriteResult {
    files: ExportFile[];
    omitted: OmittedFile[];
}

/**
 * Genera los pares de archivos de ventas y compras, general y TurIVA. Un
 * archivo sin registros no se incluye (se informa como omitido): ARCA no
 * documenta la importación de archivos vacíos.
 */
export function writeLidFiles(invoices: ExportInvoice[], settings: ExportSettings, informant?: LidInformant): LidWriteResult {
    const files: ExportFile[] = [];
    const omitted: OmittedFile[] = [];
    for (const category of ["SALES", "PURCHASES"] as const) {
        for (const turiva of [false, true]) {
            const list = invoices
                .filter((i) => i.category === category && i.voucherCode !== null && (i.lidSection === "TURIVA") === turiva)
                .sort(lidOrder);
            const vouchers: string[] = [];
            const aliquots: string[] = [];
            for (const inv of list) {
                const rows = aliquotRows(inv);
                if (category === "SALES") {
                    vouchers.push(salesVoucherRecord(inv, rows, turiva));
                    for (const r of rows) aliquots.push(salesAliquotRecord(inv, r));
                } else {
                    vouchers.push(purchaseVoucherRecord(inv, rows, settings, turiva, informant));
                    for (const r of rows) aliquots.push(purchaseAliquotRecord(inv, r));
                }
            }
            const key = `${category}_${turiva ? "TURIVA" : "GENERAL"}` as const;
            const vName = LID_FILE_NAMES[`${key}_VOUCHERS`];
            const aName = LID_FILE_NAMES[`${key}_ALIQUOTS`];
            const label = `${category === "SALES" ? "ventas" : "compras"}${turiva ? " TurIVA" : ""}`;
            if (vouchers.length === 0) {
                if (!turiva) omitted.push({ name: vName, reason: `el período no tiene comprobantes de ${label}: en ARCA se registra el libro sin movimientos` });
                continue;
            }
            files.push(file(vName, vouchers));
            if (aliquots.length > 0) files.push(file(aName, aliquots));
            else omitted.push({ name: aName, reason: `ningún comprobante de ${label} discrimina IVA (B o C): no hay registros de alícuotas` });
        }
    }
    return { files, omitted };
}
