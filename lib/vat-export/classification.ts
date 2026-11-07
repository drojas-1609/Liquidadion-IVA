import "server-only";
import { unidentifiedExportProblem } from "../arca/unidentified-buyer";
import { Prisma } from "@prisma/client";
import { VOUCHER_TYPES } from "../arca/catalogs";
import { purchaseHasNoVatBreakdown, voucherSign } from "../invoice-model";
import { toAnsiText } from "./text";
import type { ExportInvoice, ExportSettings, ExportTaxRecord } from "./types";

/**
 * Clasificaciones y controles para la presentación (lógica pura).
 *
 * Niveles (la pantalla los muestra separados y explica cómo resolver cada uno):
 *  - LIQUIDATION: impide calcular la liquidación (p. ej. falta el coeficiente
 *    de prorrateo global). Lo informa el motor; acá sólo se resume.
 *  - EXPORT: permite liquidar pero impide generar los archivos para ARCA.
 *  - WARNING: no bloquea; hay que revisarlo antes de presentar.
 *  - INFO: aclaración del contenido del paquete.
 * Los errores que impiden importar y las filas pendientes de revisión de una
 * importación se resuelven en la vista previa de la importación (no se
 * escriben en el período).
 *
 * Fuentes:
 *  - IVA Simple – Especificación de Importaciones Apertura de otros conceptos
 *    (LID-Ajustes-y-otros-conceptos-para-generar-la-DJ.pdf), consultada el 06/11/2026.
 *  - Libro IVA Digital – Especificaciones, revisión 30/07/2025.
 *  - "Tipos de responsables" (SOURCE_TIPOS_RESPONSABLES) para derivar el tipo
 *    de sujeto comprador de la condición frente al IVA ya registrada.
 */

export type IssueLevel = "LIQUIDATION" | "EXPORT" | "WARNING" | "INFO";

export type IssueCode =
    | "LEGACY_ROW"
    | "SALE_ACTIVITY_MISSING"
    | "SALE_OPERATION_TYPE_MISSING"
    | "SALE_BUYER_TYPE_MISSING"
    | "SALE_NET_WITHOUT_BREAKDOWN"
    | "SALE_ZERO_RATE_CODE"
    | "OPERATION_CODE_MISSING"
    | "PURCHASE_CONCEPT_MISSING"
    | "NAME_NOT_ANSI"
    | "NAME_TRUNCATED"
    | "NUMBER_RANGE"
    | "UNIDENTIFIED_BUYER"
    | "CURRENCY_NOT_PES"
    | "EXPORT_VOUCHER"
    | "DATION_WITHOUT_VAT"
    | "GLOBAL_PRORATION_APERTURA"
    | "PURCHASE_NC_PARTIAL_CREDIT"
    | "TAX_RECORD_DETAIL_MISSING"
    | "TAX_RECORD_NOT_IVA"
    | "INVOICE_PERCEPTIONS_NOT_REGISTERED"
    | "LIQUIDATION_NOT_COMPUTABLE";

export interface ExportIssue {
    code: IssueCode;
    level: IssueLevel;
    message: string;
    /** Comprobante o retención afectada (si corresponde). */
    invoiceId?: string;
    taxRecordId?: string;
}

/** Códigos de condición frente al IVA (Tipos de responsables) por tipo de sujeto de la apertura. */
const BUYER_TYPE_BY_CONDITION: ReadonlyMap<number, "RESPONSABLE_INSCRIPTO" | "MONOTRIBUTO" | "CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO"> = new Map([
    [1, "RESPONSABLE_INSCRIPTO"],
    [6, "MONOTRIBUTO"], // Responsable Monotributo
    [13, "MONOTRIBUTO"], // Monotributista Social
    [16, "MONOTRIBUTO"], // Monotributo Trabajador Independiente Promovido
    [4, "CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO"], // IVA Sujeto Exento
    [5, "CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO"], // Consumidor Final
    [15, "CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO"], // IVA No Alcanzado
]);

/**
 * Tipo de sujeto comprador derivado de la condición frente al IVA registrada
 * (sólo los códigos cuya correspondencia es literal). Otros (7 no categorizado,
 * 8/9 exterior, 10 liberado) quedan sin derivar: los clasifica el estudio.
 */
export function buyerTypeFromVatCondition(code: number | null): string | null {
    return code === null ? null : (BUYER_TYPE_BY_CONDITION.get(code) ?? null);
}

/** Tipo de sujeto efectivo: el clasificado o, si falta, el derivado. */
export function effectiveBuyerType(inv: Pick<ExportInvoice, "buyerType" | "counterpartyVatConditionCode">): string | null {
    return inv.buyerType ?? buyerTypeFromVatCondition(inv.counterpartyVatConditionCode);
}

export function isExportVoucher(code: number): boolean {
    return VOUCHER_TYPES.find((t) => t.code === code)?.letter === "E";
}

/** Códigos de operación que corresponden a la parte exenta / no gravada / no alcanzada de la apertura (tipo 3). */
export const EXEMPT_OPERATION_CODES = new Set(["E", "N", "A"]);

const z = (d: Prisma.Decimal | null) => d ?? new Prisma.Decimal(0);

/** Neto gravado al 0 % o comprobante sin líneas que el Libro IVA Digital registra con alícuota 0003. */
export function needsZeroRateRecord(inv: ExportInvoice): boolean {
    if (inv.voucherCode === null) return false;
    const letter = VOUCHER_TYPES.find((t) => t.code === inv.voucherCode)?.letter;
    if (inv.category === "PURCHASES" && purchaseHasNoVatBreakdown("PURCHASES", inv.voucherCode)) return false;
    if (inv.category === "SALES" && letter === "C") return false;
    return inv.vatLines.length === 0 || inv.vatLines.some((l) => l.vatRateCode === 3);
}

/** Controles de UN comprobante. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- la modalidad del período se usa en los controles futuros por modalidad
export function invoiceIssues(inv: ExportInvoice, settings: ExportSettings): ExportIssue[] {
    const out: ExportIssue[] = [];
    const add = (level: IssueLevel, code: IssueCode, message: string) => out.push({ level, code, message, invoiceId: inv.id });
    if (inv.voucherCode === null || inv.voucherDate === null || inv.voucherTotalAmount === null) {
        add("EXPORT", "LEGACY_ROW", "comprobante cargado con el modelo anterior: abrirlo y guardarlo para completar sus datos");
        return out;
    }
    const code = inv.voucherCode;
    const name = inv.counterpartyName ?? "";
    const ansi = toAnsiText(name);
    if (ansi === null) add("EXPORT", "NAME_NOT_ANSI", "la denominación tiene caracteres que el Libro IVA Digital no admite (ANSI): corregirla");
    else if (ansi.length > 30) add("WARNING", "NAME_TRUNCATED", "la denominación supera 30 caracteres: el archivo lleva los primeros 30");
    // Documento 99 y rangos: sólo la venta global diaria (B/C a consumidor final, leyenda) se registra agrupada.
    const unidentified = unidentifiedExportProblem({
        category: inv.category, voucherCode: code, number: inv.number, numberTo: inv.numberTo, voucherDate: inv.voucherDate,
        counterpartyDocType: inv.counterpartyDocType, counterpartyDocNumber: inv.counterpartyDocNumber, counterpartyName: inv.counterpartyName,
        totalCents: BigInt(inv.voucherTotalAmount.times(100).toFixed(0)),
    });
    if (unidentified !== null) add("EXPORT", inv.numberTo !== null && inv.numberTo !== inv.number && inv.counterpartyDocType !== 99 ? "NUMBER_RANGE" : "UNIDENTIFIED_BUYER", unidentified);
    if ((inv.currencyCode ?? "PES") !== "PES") add("WARNING", "CURRENCY_NOT_PES", "moneda distinta de pesos: el archivo informa los importes en pesos (PES, tipo de cambio 1)");
    if (needsZeroRateRecord(inv) && (inv.operationCode === null || inv.operationCode.trim() === "")) {
        add("EXPORT", "OPERATION_CODE_MISSING", "alícuota 0 % u operación sin IVA: falta el código de operación (E exenta, N no gravada, A no alcanzado…)");
    }

    const hasTaxed = inv.vatLines.some((l) => !l.netAmount.isZero() || !l.vatAmount.isZero());
    if (inv.category === "SALES") {
        if (isExportVoucher(code)) {
            add("INFO", "EXPORT_VOUCHER", "exportación: no integra la apertura de débito fiscal; su importe figura en los conceptos a cargar en ARCA");
        } else {
            if (inv.activityCode === null) add("EXPORT", "SALE_ACTIVITY_MISSING", "falta la actividad de la operación (código ARCA de 6 dígitos)");
            const zeroRateOnly = inv.vatLines.length > 0 && inv.vatLines.every((l) => l.vatRateCode === 3);
            if (hasTaxed && !zeroRateOnly) {
                if (inv.saleOperationType === null) add("EXPORT", "SALE_OPERATION_TYPE_MISSING", "falta el tipo de operación (cosas muebles, obras, locaciones y servicios, o bienes de uso)");
                if (effectiveBuyerType(inv) === null) add("EXPORT", "SALE_BUYER_TYPE_MISSING", "falta el tipo de sujeto comprador (no se deduce de la condición registrada)");
            }
            if (inv.vatLines.some((l) => l.vatRateCode === 3) && !EXEMPT_OPERATION_CODES.has(inv.operationCode ?? "")) {
                if (inv.operationCode !== null && inv.operationCode.trim() !== "") {
                    add("EXPORT", "SALE_ZERO_RATE_CODE", `venta al 0 % con código de operación ${inv.operationCode}: no está contemplada en la apertura de débito fiscal`);
                }
            }
            if (!z(inv.netWithoutVatBreakdownAmount).isZero()) add("EXPORT", "SALE_NET_WITHOUT_BREAKDOWN", "venta con importe sin IVA discriminado: no se puede abrir por alícuota");
            if (inv.dationInPayment && z(inv.totalVatAmount).isZero()) add("WARNING", "DATION_WITHOUT_VAT", "marcada como dación en pago (Dto. 1145/09) sin débito fiscal");
        }
    } else {
        const noBreakdown = purchaseHasNoVatBreakdown("PURCHASES", code);
        if (!noBreakdown && hasTaxed && inv.purchaseCreditConcept === null) {
            add("EXPORT", "PURCHASE_CONCEPT_MISSING", "falta el concepto del crédito fiscal (bienes, locaciones, servicios o bienes de uso)");
        }
        if (inv.vatLines.some((l) => l.creditAllocation === "GLOBAL_PRORATION")) {
            add("EXPORT", "GLOBAL_PRORATION_APERTURA", "crédito sujeto a prorrateo global: la apertura de crédito fiscal computable por concepto no se puede generar; cargarla en ARCA");
        }
        if (voucherSign(code) === -1) {
            const facturado = inv.vatLines.reduce((a, l) => a.plus(l.vatAmount), new Prisma.Decimal(0));
            const computable = inv.vatLines.reduce((a, l) => a.plus(l.computableVatAmount ?? 0), new Prisma.Decimal(0));
            if (!facturado.equals(computable) && !inv.vatLines.some((l) => l.creditAllocation === "GLOBAL_PRORATION")) {
                add("WARNING", "PURCHASE_NC_PARTIAL_CREDIT", "nota de crédito recibida con crédito computable parcial: la apertura de restitución informa el crédito facturado; revisar el ajuste en ARCA");
            }
        }
    }
    return out;
}

/** Datos del F.2051 que exige cada naturaleza (F2051-IVA-especificacion-de-importaciones.pdf). */
export function taxRecordIssues(t: ExportTaxRecord): ExportIssue[] {
    const out: ExportIssue[] = [];
    const add = (level: IssueLevel, code: IssueCode, message: string) => out.push({ level, code, message, taxRecordId: t.id });
    if (!t.type.includes("IVA")) return out; // IIBB: fuera de la presentación de IVA
    const missing: string[] = [];
    if (t.nature === null) missing.push("naturaleza");
    else if (t.nature === "RETENTION") {
        if (t.taxCode === null) missing.push("impuesto (767 o 216)");
        if (t.regimeCode === null) missing.push("régimen");
        if (t.agentCuit === null) missing.push("CUIT del agente");
        if (t.voucherTypeCode === null) missing.push("tipo de comprobante");
        if (t.voucherNumber === null) missing.push("número de comprobante");
        if (t.certificateNumber === null) missing.push("certificado");
    } else if (t.nature === "PERCEPTION") {
        if (t.regimeCode === null) missing.push("régimen");
        if (t.agentCuit === null) missing.push("CUIT del agente");
        if (t.voucherTypeCode === null) missing.push("tipo de comprobante");
        if (t.voucherNumber === null) missing.push("número de comprobante");
    } else if (t.nature === "CUSTOMS_PERCEPTION") {
        if (t.regimeCode === null) missing.push("régimen");
        if (t.customsDocument === null) missing.push("liquidación o despacho");
    }
    if (missing.length > 0) add("EXPORT", "TAX_RECORD_DETAIL_MISSING", `faltan datos para el F.2051: ${missing.join(", ")}`);
    return out;
}

/**
 * Percepciones de IVA informadas EN comprobantes de compra frente a las
 * registradas como retención/percepción. La liquidación computa SÓLO las
 * registradas (fuente única, sin duplicar): una percepción del comprobante sin
 * registrar no se computa hasta que se registre (vinculada o no).
 */
export function perceptionControl(invoices: Pick<ExportInvoice, "id" | "category" | "voucherCode" | "vatPerceptionAmount">[], records: Pick<ExportTaxRecord, "invoiceId" | "type">[]): ExportIssue[] {
    const linked = new Set(records.filter((r) => r.invoiceId !== null).map((r) => r.invoiceId));
    const out: ExportIssue[] = [];
    for (const i of invoices) {
        if (i.category !== "PURCHASES" || i.voucherCode === null) continue;
        if (z(i.vatPerceptionAmount).isZero() || linked.has(i.id)) continue;
        out.push({
            level: "WARNING",
            code: "INVOICE_PERCEPTIONS_NOT_REGISTERED",
            invoiceId: i.id,
            message: `percepción de IVA de ${z(i.vatPerceptionAmount).toFixed(2)} informada en el comprobante y no registrada: no se computa. Registrarla desde el comprobante o confirmar que ya está cargada por separado`,
        });
    }
    return out;
}
