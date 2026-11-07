import "server-only";
import { Prisma } from "@prisma/client";
import { voucherSign } from "../invoice-model";
import { EXEMPT_OPERATION_CODES, effectiveBuyerType, isExportVoucher } from "./classification";
import { ExportFormatError, crlfJoin, csvAmount, encodeAnsi } from "./text";
import type { ExportFile, ExportInvoice, OmittedFile } from "./types";

/**
 * Los cuatro CSV de "Apertura de otros conceptos" de IVA Simple (Portal IVA →
 * Ajustes y otros conceptos), según "IVA simple – Especificación de
 * Importaciones Apertura de otros conceptos"
 * (https://www.arca.gob.ar/iva/documentos/LID-Ajustes-y-otros-conceptos-para-generar-la-DJ.pdf,
 * consultado el 06/11/2026). Un registro por combinación de la apertura
 * (no por comprobante), separador ";" y "," decimal.
 *
 * Forma del archivo: encabezado y campos como las plantillas de ejemplo de
 * IVA Simple (encabezado entre comillas, CRLF, sin salto final) y la cantidad
 * completa de campos del diseño en cada registro (los vacíos del final se
 * escriben, como en los ejemplos del PDF). El diseño no fija un encabezado: si
 * ARCA rechazara la primera línea, ver docs/presentacion-iva/README.md.
 *
 *  1) Débito Fiscal: actividad · tipo de operación (1 cosas muebles, obras,
 *     locaciones y servicios; 2 bienes de uso; 3 no gravadas o exentas, excepto
 *     exportaciones) · tipo de sujeto (1 RI, 2 monotributo, 3 consumidor final,
 *     exento y no alcanzado) · alícuota · neto · débito facturado · débito de
 *     operaciones de dación en pago (Decreto 1145/09, sólo beneficiarios) ·
 *     neto exento o no gravado (sólo tipo 3).
 *  2) Restitución de Débito Fiscal (notas de crédito emitidas): tipo 1 (incluye
 *     bienes de uso) o 2 (no gravadas o exentas); sin dación en pago.
 *  3) Crédito Fiscal: concepto · alícuota · neto · crédito facturado · computable.
 *  4) Restitución de Crédito Fiscal (notas de crédito recibidas): concepto ·
 *     alícuota · neto · crédito facturado.
 *
 * Fuera de los CSV (no los contemplan): exportaciones, saldo técnico y de libre
 * disponibilidad anteriores, retenciones y percepciones y el crédito por
 * contribuciones a la Seguridad Social: van en el resumen de conceptos a cargar.
 */

export const IVA_SIMPLE_FILE_NAMES = {
    DEBIT: "IVA_SIMPLE_DEBITO_FISCAL.csv",
    DEBIT_RESTITUTION: "IVA_SIMPLE_RESTITUCION_DEBITO_FISCAL.csv",
    CREDIT: "IVA_SIMPLE_CREDITO_FISCAL.csv",
    CREDIT_RESTITUTION: "IVA_SIMPLE_RESTITUCION_CREDITO_FISCAL.csv",
} as const;

export const IVA_SIMPLE_HEADERS = {
    DEBIT: ["Actividad", "Tipo de Operacion", "Tipo de sujeto comprador", "Codigo de Alicuota", "Monto Neto Gravado", "Debito Fiscal Facturado", "Debito Fiscal O.D.P.", "Monto Neto Exento o No Gravado"],
    DEBIT_RESTITUTION: ["Actividad", "Tipo de Operacion", "Tipo de sujeto comprador", "Codigo de Alicuota", "Monto Neto Gravado", "Debito Fiscal a Restituir", "Monto Neto Exento o No Gravado"],
    CREDIT: ["Concepto", "Codigo de Alicuota", "Monto Neto Gravado", "Credito Fiscal Facturado", "Credito Fiscal Computable"],
    CREDIT_RESTITUTION: ["Concepto", "Codigo de Alicuota", "Monto Neto Gravado", "Credito Fiscal Facturado"],
} as const;

const MAX_INT = 13;
const ZERO = new Prisma.Decimal(0);
const z = (d: Prisma.Decimal | null) => d ?? ZERO;

const OPERATION_TYPE_CODE: Record<string, string> = { GOODS_SERVICES: "1", CAPITAL_GOODS: "2" };
const BUYER_TYPE_CODE: Record<string, string> = { RESPONSABLE_INSCRIPTO: "1", MONOTRIBUTO: "2", CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO: "3" };
const CONCEPT_CODE: Record<string, string> = { GOODS: "1", LEASES: "2", SERVICES: "3", CAPITAL_GOODS: "4" };
/** Alícuotas de la apertura (mismos códigos que las Tablas del Sistema). */
const APERTURA_RATES = new Set([3, 9, 8, 4, 5, 6]);

function rate(code: number): string {
    if (!APERTURA_RATES.has(code)) throw new ExportFormatError(`alícuota ${code} fuera de la apertura`);
    return String(code);
}

class Acc {
    private m = new Map<string, Prisma.Decimal[]>();
    add(key: string, values: Prisma.Decimal[]): void {
        const cur = this.m.get(key);
        this.m.set(key, cur ? cur.map((v, i) => v.plus(values[i])) : values);
    }
    entries(): [string, Prisma.Decimal[]][] {
        return [...this.m.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }));
    }
}

/** Totales de cada CSV para la conciliación con el motor. */
export interface IvaSimpleTotals {
    debitVat: Prisma.Decimal;
    debitOdp: Prisma.Decimal;
    debitExempt: Prisma.Decimal;
    debitRestitutionVat: Prisma.Decimal;
    creditVat: Prisma.Decimal;
    creditComputable: Prisma.Decimal;
    creditRestitutionVat: Prisma.Decimal;
    /** Exportaciones (fuera de la apertura): total con signo. */
    exportsTotal: Prisma.Decimal;
}

export interface IvaSimpleResult {
    files: ExportFile[];
    omitted: OmittedFile[];
    totals: IvaSimpleTotals;
}

function csvFile(name: string, header: readonly string[], rows: string[][]): ExportFile {
    const lines = [header.map((h) => `"${h}"`).join(";"), ...rows.map((r) => r.join(";"))];
    return { name, bytes: encodeAnsi(crlfJoin(lines)), records: rows.length };
}

/**
 * Genera los CSV. Exige comprobantes ya clasificados: ante un dato faltante
 * lanza ExportFormatError (los controles de classification.ts lo informan antes).
 */
export function writeIvaSimpleFiles(invoices: ExportInvoice[]): IvaSimpleResult {
    const debit = new Acc(), debitExempt = new Acc(), restDebit = new Acc(), restDebitExempt = new Acc(), credit = new Acc(), restCredit = new Acc();
    let exportsTotal = ZERO;
    for (const inv of invoices) {
        if (inv.voucherCode === null) throw new ExportFormatError("comprobante sin modelo contable");
        const nc = voucherSign(inv.voucherCode) === -1;
        if (inv.category === "SALES") {
            if (isExportVoucher(inv.voucherCode)) {
                exportsTotal = exportsTotal.plus(z(inv.voucherTotalAmount).times(nc ? -1 : 1));
                continue;
            }
            if (inv.activityCode === null || !/^\d{6}$/.test(inv.activityCode)) throw new ExportFormatError("venta sin actividad");
            const act = inv.activityCode;
            const exemptOnlyCode = EXEMPT_OPERATION_CODES.has(inv.operationCode ?? "");
            let exemptPart = z(inv.exemptAmount).plus(z(inv.nonTaxedAmount));
            for (const l of inv.vatLines) {
                if (l.vatRateCode === 3 && exemptOnlyCode) {
                    // Neto al 0 % de una operación exenta / no gravada / no alcanzada: tipo 3.
                    exemptPart = exemptPart.plus(l.netAmount);
                    continue;
                }
                if (l.vatRateCode === 3) throw new ExportFormatError("venta al 0 % sin código de operación exenta, no gravada o no alcanzada");
                if (inv.saleOperationType === null) throw new ExportFormatError("venta sin tipo de operación");
                const buyer = effectiveBuyerType(inv);
                if (buyer === null) throw new ExportFormatError("venta sin tipo de sujeto comprador");
                const odp = inv.dationInPayment ? l.vatAmount : ZERO;
                if (nc) {
                    // Restitución: tipo 1 comprende también los bienes de uso.
                    restDebit.add(`${act};1;${BUYER_TYPE_CODE[buyer]};${rate(l.vatRateCode)}`, [l.netAmount, l.vatAmount]);
                } else {
                    debit.add(`${act};${OPERATION_TYPE_CODE[inv.saleOperationType]};${BUYER_TYPE_CODE[buyer]};${rate(l.vatRateCode)}`, [l.netAmount, l.vatAmount, odp]);
                }
            }
            if (!exemptPart.isZero()) (nc ? restDebitExempt : debitExempt).add(act, [exemptPart]);
        } else if (inv.category === "PURCHASES") {
            for (const l of inv.vatLines) {
                if (l.netAmount.isZero() && l.vatAmount.isZero()) continue;
                if (l.creditAllocation === "GLOBAL_PRORATION") throw new ExportFormatError("crédito con prorrateo global en la apertura");
                if (inv.purchaseCreditConcept === null) throw new ExportFormatError("compra sin concepto del crédito");
                const key = `${CONCEPT_CODE[inv.purchaseCreditConcept]};${rate(l.vatRateCode)}`;
                const computable = l.creditAllocation === "DIRECT_COMPUTABLE" ? z(l.computableVatAmount) : ZERO;
                if (nc) restCredit.add(key, [l.netAmount, l.vatAmount]);
                else credit.add(key, [l.netAmount, l.vatAmount, computable]);
            }
        }
    }

    const a = (d: Prisma.Decimal) => csvAmount(d, MAX_INT);
    const debitRows = [
        ...debit.entries().map(([k, [net, vat, odp]]) => [...k.split(";"), a(net), a(vat), odp.isZero() ? "" : a(odp), ""]),
        ...debitExempt.entries().map(([act, [ex]]) => [act, "3", "", "", "", "", "", a(ex)]),
    ];
    const restDebitRows = [
        ...restDebit.entries().map(([k, [net, vat]]) => [...k.split(";"), a(net), a(vat), ""]),
        ...restDebitExempt.entries().map(([act, [ex]]) => [act, "2", "", "", "", "", a(ex)]),
    ];
    const creditRows = credit.entries().map(([k, [net, vat, comp]]) => [...k.split(";"), a(net), a(vat), a(comp)]);
    const restCreditRows = restCredit.entries().map(([k, [net, vat]]) => [...k.split(";"), a(net), a(vat)]);

    const sumCol = (acc: Acc, i: number) => acc.entries().reduce((s, [, v]) => s.plus(v[i]), ZERO);
    const totals: IvaSimpleTotals = {
        debitVat: sumCol(debit, 1),
        debitOdp: sumCol(debit, 2),
        debitExempt: sumCol(debitExempt, 0),
        debitRestitutionVat: sumCol(restDebit, 1),
        creditVat: sumCol(credit, 1),
        creditComputable: sumCol(credit, 2),
        creditRestitutionVat: sumCol(restCredit, 1),
        exportsTotal,
    };

    const files: ExportFile[] = [];
    const omitted: OmittedFile[] = [];
    const push = (name: string, header: readonly string[], rows: string[][], none: string) => {
        if (rows.length > 0) files.push(csvFile(name, header, rows));
        else omitted.push({ name, reason: none });
    };
    push(IVA_SIMPLE_FILE_NAMES.DEBIT, IVA_SIMPLE_HEADERS.DEBIT, debitRows, "no hay operaciones que generen débito fiscal en la apertura");
    push(IVA_SIMPLE_FILE_NAMES.DEBIT_RESTITUTION, IVA_SIMPLE_HEADERS.DEBIT_RESTITUTION, restDebitRows, "no hay notas de crédito emitidas");
    push(IVA_SIMPLE_FILE_NAMES.CREDIT, IVA_SIMPLE_HEADERS.CREDIT, creditRows, "no hay compras con IVA discriminado");
    push(IVA_SIMPLE_FILE_NAMES.CREDIT_RESTITUTION, IVA_SIMPLE_HEADERS.CREDIT_RESTITUTION, restCreditRows, "no hay notas de crédito recibidas con IVA discriminado");
    return { files, omitted, totals };
}
