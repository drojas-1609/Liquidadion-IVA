import "server-only";
import * as XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import { D, sum } from "./decimal";
import { VAT_RATES } from "./arca/catalogs";
import { voucherDisplayLabel, voucherSign, vatRateCodeFor } from "./invoice-model";

/**
 * Hojas de detalle de la exportación de la liquidación: Ventas, Compras,
 * Retenciones y Percepciones del período, y una hoja «Control» que compara sus
 * totales con los de la liquidación, para el control cruzado en el mismo libro.
 *
 * Criterios (los mismos de lib/liquidation-calc):
 *  - Signo: sólo por el código oficial del comprobante; las notas de crédito
 *    restan (importes negativos en la hoja).
 *  - Débito fiscal = IVA liquidado de las ventas; crédito directo = IVA
 *    computable directo de las compras (el prorrateo global va aparte).
 *  - Impuesto de cada retención o percepción: «IVA» si el tipo contiene IVA;
 *    «IIBB» si contiene IIBB o es SIRCREB/SIRTAC. Percepción si el tipo es una
 *    percepción o la naturaleza es percepción aduanera; si no, retención.
 *
 * Los importes entran como Prisma.Decimal y se convierten a número sólo al
 * escribir la celda, con la misma guarda de rango que la hoja de liquidación.
 */

export interface DetailInvoice {
    category: string;
    date: Date | null;
    voucherDate?: Date | null;
    type: string | null;
    pointOfSale: number;
    number: number;
    numberTo?: number | null;
    entityName: string | null;
    entityCuit: string | null;
    netAmount: Prisma.Decimal;
    vatRate: Prisma.Decimal | null;
    vatAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    voucherCode?: number | null;
    counterpartyDocType?: number | null;
    counterpartyDocNumber?: string | null;
    counterpartyName?: string | null;
    operationCode?: string | null;
    purchaseAccount?: string | null;
    taxedNetAmount?: Prisma.Decimal | null;
    totalVatAmount?: Prisma.Decimal | null;
    directComputableVatCreditAmount?: Prisma.Decimal | null;
    netWithoutVatBreakdownAmount?: Prisma.Decimal | null;
    nonTaxedAmount?: Prisma.Decimal | null;
    exemptAmount?: Prisma.Decimal | null;
    vatPerceptionAmount?: Prisma.Decimal | null;
    nationalPerceptionAmount?: Prisma.Decimal | null;
    iibbPerceptionAmount?: Prisma.Decimal | null;
    municipalPerceptionAmount?: Prisma.Decimal | null;
    internalTaxesAmount?: Prisma.Decimal | null;
    otherTaxesAmount?: Prisma.Decimal | null;
    grossIncomeTaxBaseAmount?: Prisma.Decimal | null;
    voucherTotalAmount?: Prisma.Decimal | null;
    source?: string | null;
    vatLines?: Array<{ vatRateCode: number; netAmount: Prisma.Decimal; vatAmount: Prisma.Decimal; creditAllocation: string }>;
}

export interface DetailTaxRecord {
    date: Date;
    type: string;
    amount: Prisma.Decimal;
    description: string | null;
    nature?: string | null;
    taxCode?: number | null;
    regimeCode?: number | null;
    agentCuit?: string | null;
    voucherTypeCode?: number | null;
    voucherNumber?: string | null;
    certificateNumber?: string | null;
    customsDocument?: string | null;
}

/** Totales de la liquidación con los que se cruza el detalle (strings decimales). */
export interface DetailControlTotals {
    salesTotal: string;
    purchasesTotal: string;
    debit: string;
    creditDirect: string;
    creditProrated: string;
    iibbBase: string;
    ivaWithholdings: string;
    ivaPerceptions: string;
    iibbRetentions: string;
}

type Cell = string | number | Date | null;
type ToNumber = (value: string) => number;

const MONEY = "#,##0.00;-#,##0.00";
const MODELED = (i: DetailInvoice) => i.voucherCode != null && i.totalVatAmount != null && i.voucherTotalAmount != null;
const ZERO = D("0");
const or0 = (v: Prisma.Decimal | null | undefined) => v ?? ZERO;

function rateLabel(code: number) {
    const rate = VAT_RATES.find((r) => r.code === code)?.rate ?? String(code);
    return rate.replace(".", ",") + " %";
}

/** Columna de Excel (0 → A). */
function col(index: number): string {
    let s = "";
    let n = index + 1;
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

interface Column {
    header: string;
    width: number;
    money?: boolean;
    value: (row: number) => Cell | Prisma.Decimal;
}

/**
 * Arma una hoja con encabezado, filas y una fila de totales con fórmulas SUM
 * en las columnas de importes. Devuelve la hoja y la dirección del total de
 * cada columna de importes, para referenciarla desde «Control».
 */
function buildSheet(title: string, note: string, columns: Column[], count: number, n: ToNumber) {
    const HEADER_ROW = 3; // 0-based: título, nota, vacía, encabezado
    const aoa: Cell[][] = [[title], [note], [], columns.map((c) => c.header)];
    for (let r = 0; r < count; r++) {
        aoa.push(columns.map((c) => {
            const v = c.value(r);
            if (v instanceof Prisma.Decimal) return n(v.toFixed(2));
            return v;
        }));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: "dd/mm/yyyy" });
    const first = HEADER_ROW + 2; // primera fila de datos (1-based)
    const last = HEADER_ROW + 1 + count;
    const totalRow = last + 1;
    const totals: Record<string, string> = {};
    const values: Record<string, string> = {};
    columns.forEach((c, i) => {
        if (!c.money) return;
        const letter = col(i);
        for (let r = first; r <= last; r++) {
            const cell = ws[`${letter}${r}`];
            if (cell && cell.t === "n") cell.z = MONEY;
        }
        // Valor precalculado (visible aunque el visor no recalcule) + fórmula.
        let acc = ZERO;
        for (let r = 0; r < count; r++) {
            const v = c.value(r);
            if (v instanceof Prisma.Decimal) acc = acc.plus(D(v.toFixed(2)));
        }
        ws[`${letter}${totalRow}`] = { t: "n", v: n(acc.toFixed(2)), f: count ? `SUM(${letter}${first}:${letter}${last})` : undefined, z: MONEY };
        totals[c.header] = `${letter}${totalRow}`;
        values[c.header] = acc.toFixed(2);
    });
    ws[`A${totalRow}`] = { t: "s", v: `TOTAL (${count} ${count === 1 ? "fila" : "filas"})` };
    ws["!ref"] = `A1:${col(columns.length - 1)}${totalRow}`;
    ws["!cols"] = columns.map((c) => ({ wch: c.width }));
    ws["!autofilter"] = { ref: `A${HEADER_ROW + 1}:${col(columns.length - 1)}${last}` };
    return { ws, totals, values };
}

function invoiceDate(i: DetailInvoice) {
    return i.voucherDate ?? i.date ?? null;
}

function sortInvoices(list: DetailInvoice[]) {
    return [...list].sort((a, b) => {
        const da = invoiceDate(a)?.getTime() ?? 0;
        const db = invoiceDate(b)?.getTime() ?? 0;
        return da - db || (a.voucherCode ?? 0) - (b.voucherCode ?? 0) || a.pointOfSale - b.pointOfSale || a.number - b.number;
    });
}

interface InvoiceRow {
    inv: DetailInvoice;
    sign: number;
    byRate: Map<number, { net: Prisma.Decimal; vat: Prisma.Decimal }>;
    netWithout: Prisma.Decimal;
    vatTotal: Prisma.Decimal;
    total: Prisma.Decimal;
    globalVat: Prisma.Decimal;
}

function invoiceRow(inv: DetailInvoice): InvoiceRow {
    const byRate = new Map<number, { net: Prisma.Decimal; vat: Prisma.Decimal }>();
    if (MODELED(inv)) {
        const sign = voucherSign(inv.voucherCode as number);
        for (const line of inv.vatLines ?? []) {
            const prev = byRate.get(line.vatRateCode) ?? { net: ZERO, vat: ZERO };
            byRate.set(line.vatRateCode, { net: prev.net.plus(line.netAmount.times(sign)), vat: prev.vat.plus(line.vatAmount.times(sign)) });
        }
        const globalVat = sum((inv.vatLines ?? []).filter((l) => l.creditAllocation === "GLOBAL_PRORATION").map((l) => l.vatAmount)).times(sign);
        return {
            inv, sign, byRate, globalVat,
            netWithout: or0(inv.netWithoutVatBreakdownAmount).times(sign),
            vatTotal: (inv.totalVatAmount as Prisma.Decimal).times(sign),
            total: (inv.voucherTotalAmount as Prisma.Decimal).times(sign),
        };
    }
    // Comprobante anterior al modelo completo: se informa como lo liquida la app.
    const code = inv.vatRate ? vatRateCodeFor(inv.vatRate) : null;
    if (code !== null) byRate.set(code, { net: inv.netAmount, vat: inv.vatAmount });
    return {
        inv, sign: 1, byRate, globalVat: ZERO,
        netWithout: code === null ? inv.netAmount : ZERO,
        vatTotal: inv.vatAmount,
        total: inv.totalAmount,
    };
}

function invoiceSheet(category: "SALES" | "PURCHASES", invoices: DetailInvoice[], n: ToNumber) {
    const rows = sortInvoices(invoices.filter((i) => i.category === category)).map(invoiceRow);
    const rateCodes = [5, 4, 6, 8, 9, 3].filter((code) => code === 5 || code === 4 || rows.some((r) => r.byRate.has(code)));
    const signed = (r: InvoiceRow, v: Prisma.Decimal | null | undefined) => MODELED(r.inv) ? or0(v).times(r.sign) : ZERO;
    const columns: Column[] = [
        { header: "Fecha", width: 11, value: (i) => invoiceDate(rows[i].inv) },
        { header: "Tipo", width: 8, value: (i) => rows[i].inv.voucherCode ?? null },
        { header: "Comprobante", width: 26, value: (i) => (rows[i].inv.voucherCode != null ? voucherDisplayLabel(rows[i].inv.voucherCode as number) : rows[i].inv.type) ?? "" },
        { header: "Punto de venta", width: 9, value: (i) => rows[i].inv.pointOfSale },
        { header: "Número", width: 11, value: (i) => rows[i].inv.number },
        { header: "Número hasta", width: 11, value: (i) => rows[i].inv.numberTo ?? null },
        { header: "Tipo doc.", width: 8, value: (i) => rows[i].inv.counterpartyDocType ?? null },
        { header: category === "SALES" ? "Doc. comprador" : "Doc. vendedor", width: 14, value: (i) => rows[i].inv.counterpartyDocNumber ?? rows[i].inv.entityCuit ?? "" },
        { header: category === "SALES" ? "Comprador" : "Vendedor", width: 34, value: (i) => rows[i].inv.counterpartyName ?? rows[i].inv.entityName ?? "" },
        { header: "Cód. operación", width: 9, value: (i) => rows[i].inv.operationCode ?? "" },
    ];
    if (category === "PURCHASES") columns.push({ header: "Cuenta de compra", width: 20, value: (i) => rows[i].inv.purchaseAccount ?? "" });
    for (const code of rateCodes) {
        columns.push({ header: `Neto ${rateLabel(code)}`, width: 15, money: true, value: (i) => rows[i].byRate.get(code)?.net ?? ZERO });
        if (code !== 3) columns.push({ header: `IVA ${rateLabel(code)}`, width: 14, money: true, value: (i) => rows[i].byRate.get(code)?.vat ?? ZERO });
    }
    columns.push(
        { header: "Neto sin desglose de IVA", width: 15, money: true, value: (i) => rows[i].netWithout },
        { header: "No gravado", width: 14, money: true, value: (i) => signed(rows[i], rows[i].inv.nonTaxedAmount) },
        { header: "Exento", width: 14, money: true, value: (i) => signed(rows[i], rows[i].inv.exemptAmount) },
        { header: "Percepciones IVA", width: 14, money: true, value: (i) => signed(rows[i], rows[i].inv.vatPerceptionAmount) },
        { header: "Percepciones nacionales", width: 14, money: true, value: (i) => signed(rows[i], rows[i].inv.nationalPerceptionAmount) },
        { header: "Percepciones IIBB", width: 14, money: true, value: (i) => signed(rows[i], rows[i].inv.iibbPerceptionAmount) },
        { header: "Percepciones municipales", width: 14, money: true, value: (i) => signed(rows[i], rows[i].inv.municipalPerceptionAmount) },
        { header: "Impuestos internos", width: 14, money: true, value: (i) => signed(rows[i], rows[i].inv.internalTaxesAmount) },
        { header: "Otros tributos", width: 14, money: true, value: (i) => signed(rows[i], rows[i].inv.otherTaxesAmount) },
        { header: "IVA total", width: 15, money: true, value: (i) => rows[i].vatTotal },
        { header: "Total", width: 16, money: true, value: (i) => rows[i].total },
    );
    if (category === "SALES") {
        columns.push({ header: "Base IIBB", width: 16, money: true, value: (i) => (MODELED(rows[i].inv) ? signed(rows[i], rows[i].inv.grossIncomeTaxBaseAmount) : rows[i].inv.netAmount) });
    } else {
        columns.push(
            { header: "Crédito fiscal directo computable", width: 16, money: true, value: (i) => (MODELED(rows[i].inv) ? signed(rows[i], rows[i].inv.directComputableVatCreditAmount) : rows[i].inv.vatAmount) },
            { header: "IVA sujeto a prorrateo global", width: 16, money: true, value: (i) => rows[i].globalVat },
        );
    }
    columns.push({ header: "Origen", width: 14, value: (i) => rows[i].inv.source ?? "" });
    const title = category === "SALES" ? "Comprobantes de ventas del período" : "Comprobantes de compras del período";
    return buildSheet(title, "Las notas de crédito restan (importes negativos). Totales con fórmula SUM al pie.", columns, rows.length, n);
}

function taxOf(type: string): "IVA" | "IIBB" | "" {
    if (type.includes("IVA")) return "IVA";
    if (type.includes("IIBB") || type === "SIRCREB" || type === "SIRTAC") return "IIBB";
    return "";
}
const isPerception = (t: DetailTaxRecord) => t.nature === "CUSTOMS_PERCEPTION" || t.type.includes("PERCEPCION");

function taxSheet(kind: "RETENTIONS" | "PERCEPTIONS", records: DetailTaxRecord[], n: ToNumber) {
    const rows = records.filter((t) => (kind === "PERCEPTIONS") === isPerception(t)).sort((a, b) => a.date.getTime() - b.date.getTime());
    const columns: Column[] = [
        { header: "Fecha", width: 11, value: (i) => rows[i].date },
        { header: "Impuesto", width: 9, value: (i) => taxOf(rows[i].type) },
        { header: "Tipo", width: 20, value: (i) => rows[i].type },
        { header: "Naturaleza", width: 18, value: (i) => (rows[i].nature === "CUSTOMS_PERCEPTION" ? "Percepción aduanera" : "") },
        { header: "CUIT agente", width: 14, value: (i) => rows[i].agentCuit ?? "" },
        { header: "Impuesto (código)", width: 10, value: (i) => rows[i].taxCode ?? null },
        { header: "Régimen", width: 9, value: (i) => rows[i].regimeCode ?? null },
        { header: "Tipo de comprobante", width: 10, value: (i) => rows[i].voucherTypeCode ?? null },
        { header: "Número de comprobante", width: 22, value: (i) => rows[i].voucherNumber ?? rows[i].customsDocument ?? "" },
        { header: "Certificado", width: 20, value: (i) => rows[i].certificateNumber ?? "" },
        { header: "Descripción", width: 36, value: (i) => rows[i].description ?? "" },
        { header: "Importe", width: 16, money: true, value: (i) => rows[i].amount },
    ];
    const title = kind === "RETENTIONS" ? "Retenciones y recaudaciones del período" : "Percepciones del período";
    const built = buildSheet(title, "Columna «Impuesto»: IVA o IIBB, el mismo criterio de la liquidación.", columns, rows.length, n);
    return { ...built, count: rows.length };
}

/**
 * Agrega las hojas de detalle y la de control al libro. `liquidationCells`
 * da la dirección, en la hoja «Liquidacion», de los importes que la hoja de
 * control referencia (para que el cruce siga vivo si se editan).
 */
export function appendDetailSheets(
    wb: XLSX.WorkBook,
    detail: { invoices: DetailInvoice[]; taxRecords: DetailTaxRecord[]; totals: DetailControlTotals },
    liquidationCells: Partial<Record<keyof DetailControlTotals, string>>,
    n: ToNumber,
) {
    const sales = invoiceSheet("SALES", detail.invoices, n);
    const purchases = invoiceSheet("PURCHASES", detail.invoices, n);
    const retentions = taxSheet("RETENTIONS", detail.taxRecords, n);
    const perceptions = taxSheet("PERCEPTIONS", detail.taxRecords, n);
    XLSX.utils.book_append_sheet(wb, sales.ws, "Ventas");
    XLSX.utils.book_append_sheet(wb, purchases.ws, "Compras");
    XLSX.utils.book_append_sheet(wb, retentions.ws, "Retenciones");
    XLSX.utils.book_append_sheet(wb, perceptions.ws, "Percepciones");

    const amountCol = (sheet: "Retenciones" | "Percepciones", rowsCount: number) => `${sheet}!$L$5:$L$${4 + Math.max(rowsCount, 1)}`;
    const taxCol = (sheet: "Retenciones" | "Percepciones", rowsCount: number) => `${sheet}!$B$5:$B$${4 + Math.max(rowsCount, 1)}`;
    const sumIf = (sheet: "Retenciones" | "Percepciones", rowsCount: number, tax: string) => `SUMIF(${taxCol(sheet, rowsCount)},"${tax}",${amountCol(sheet, rowsCount)})`;
    const t = detail.totals;
    const records = detail.taxRecords;
    const detailSum = (filter: (r: DetailTaxRecord) => boolean) => sum(records.filter(filter).map((r) => r.amount)).toFixed(2);

    const checks: Array<{ label: string; key: keyof DetailControlTotals; formula: string; detailValue: string }> = [
        { label: "Débito fiscal (IVA de ventas)", key: "debit", formula: `Ventas!${sales.totals["IVA total"]}`, detailValue: sales.values["IVA total"] },
        { label: "Crédito fiscal directo computable de compras", key: "creditDirect", formula: `Compras!${purchases.totals["Crédito fiscal directo computable"]}`, detailValue: purchases.values["Crédito fiscal directo computable"] },
        { label: "Total de ventas", key: "salesTotal", formula: `Ventas!${sales.totals["Total"]}`, detailValue: sales.values["Total"] },
        { label: "Total de compras", key: "purchasesTotal", formula: `Compras!${purchases.totals["Total"]}`, detailValue: purchases.values["Total"] },
        { label: "Base imponible IIBB", key: "iibbBase", formula: `Ventas!${sales.totals["Base IIBB"]}`, detailValue: sales.values["Base IIBB"] },
        {
            label: "Retenciones de IVA", key: "ivaWithholdings", formula: sumIf("Retenciones", retentions.count, "IVA"),
            detailValue: detailSum((r) => !isPerception(r) && taxOf(r.type) === "IVA"),
        },
        {
            label: "Percepciones de IVA (incluye aduaneras)", key: "ivaPerceptions", formula: sumIf("Percepciones", perceptions.count, "IVA"),
            detailValue: detailSum((r) => isPerception(r) && taxOf(r.type) === "IVA"),
        },
        {
            label: "Retenciones, percepciones y recaudaciones de IIBB", key: "iibbRetentions",
            formula: `${sumIf("Retenciones", retentions.count, "IIBB")}+${sumIf("Percepciones", perceptions.count, "IIBB")}`,
            detailValue: detailSum((r) => taxOf(r.type) === "IIBB"),
        },
    ];

    const aoa: Cell[][] = [
        ["Control cruzado: liquidación vs. detalle de comprobantes"],
        ["La diferencia debe ser 0. Las columnas usan fórmulas: si se edita una hoja, el control se recalcula."],
        [],
        ["Concepto", "Según liquidación", "Según detalle", "Diferencia"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    checks.forEach((c, i) => {
        const r = 5 + i;
        ws[`A${r}`] = { t: "s", v: c.label };
        const cell = liquidationCells[c.key];
        ws[`B${r}`] = { t: "n", v: n(t[c.key]), z: MONEY, ...(cell ? { f: `Liquidacion!${cell}` } : {}) };
        ws[`C${r}`] = { t: "n", v: n(c.detailValue), f: c.formula, z: MONEY };
        ws[`D${r}`] = { t: "n", v: n(D(c.detailValue).minus(D(t[c.key])).toFixed(2)), f: `C${r}-B${r}`, z: MONEY };
    });
    let last = 4 + checks.length;
    if (!D(t.creditProrated).isZero()) {
        last += 2;
        ws[`A${last}`] = { t: "s", v: "Crédito por prorrateo global (no surge de una columna: coeficiente × IVA sujeto a prorrateo)" };
        ws[`B${last}`] = { t: "n", v: n(t.creditProrated), z: MONEY };
    }
    ws["!ref"] = `A1:D${last}`;
    ws["!cols"] = [{ wch: 58 }, { wch: 20 }, { wch: 20 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws, "Control");
}
