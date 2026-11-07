import "server-only";
import { Prisma } from "@prisma/client";
import { D, ZERO, sum, moneyInRange } from "./decimal";
import { parseMoney } from "./validation/decimal";
import { parseExpectedUpdatedAt, parseIsoDateOnly } from "./api-input";
import { VAT_CONDITIONS, VAT_RATES } from "./arca/catalogs";
import { checkVoucherDate, type InvoiceWarning } from "./invoice-rules";
import {
    computeLineVat,
    computeVoucherTotal,
    directComputableOf,
    purchaseHasNoVatBreakdown,
    vatLineError,
    voucherType,
    type InvoiceCategory,
    type InvoiceModelData,
    type PeriodVatSettingsLike,
    type VatCreditAllocation,
    type VatLineData,
    type VoucherAmounts,
} from "./invoice-model";
import { OPERATION_CODES } from "./libro-iva-import/build";

/**
 * Corrección DETALLADA de un comprobante IMPORTADO: conserva todo lo que trajo
 * la importación (varias alícuotas, exento, no gravado, sin discriminar,
 * percepciones, tributos, reintegro TurIVA, código de operación, crédito
 * informado y su atribución por línea) y aplica las MISMAS reglas que la
 * importación (lib/libro-iva-import/build.ts), pero sin margen de revisión:
 * lo que allá quedaría para revisar, acá se rechaza con el motivo.
 *
 * La identidad del comprobante (tipo, punto de venta, número, documento de la
 * contraparte, categoría, período y pestaña) NO se edita: es la clave con la
 * que la importación reconoce el comprobante ("ya cargado") y la que identifica
 * el comprobante en ARCA. Para cambiarla hay que eliminarlo y cargarlo de nuevo.
 * Las clasificaciones de la presentación (actividad, tipo de operación,
 * sujeto, concepto del crédito, dación en pago) tampoco se tocan acá: se
 * conservan y se editan en «Presentación ARCA».
 *
 * Lógica pura, sin base de datos: la ruta la ejecuta sobre la fila BLOQUEADA.
 */

export const DETAILED_EDIT_CONTRACT = "DETAILED_V1" as const;
const VAT_TOLERANCE = D("0.01");
const NAME_MAX = 200;

/** Importes de cabecera editables (siempre positivos; el signo sale del código). */
export const DETAILED_AMOUNT_FIELDS = [
    "netWithoutVatBreakdownAmount",
    "nonTaxedAmount",
    "exemptAmount",
    "vatPerceptionAmount",
    "nationalPerceptionAmount",
    "iibbPerceptionAmount",
    "municipalPerceptionAmount",
    "internalTaxesAmount",
    "otherTaxesAmount",
    "turivaRefundAmount",
] as const;
export type DetailedAmountField = (typeof DETAILED_AMOUNT_FIELDS)[number];

export interface DetailedLineInput {
    vatRateCode: number;
    netAmount: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    creditAllocation: VatCreditAllocation;
    computableVatAmount: Prisma.Decimal | null;
}

export interface DetailedEditInput {
    expectedUpdatedAt: Date;
    voucherDate: Date;
    counterpartyName: string;
    counterpartyVatConditionCode: number | null;
    operationCode: string | null;
    amounts: Record<DetailedAmountField, Prisma.Decimal>;
    reportedComputableVatCreditAmount: Prisma.Decimal | null;
    vatLines: DetailedLineInput[];
}

export type DetailedParse = { ok: true; data: DetailedEditInput } | { ok: false; field: string; error: string };
const fail = (field: string, error: string): { ok: false; field: string; error: string } => ({ ok: false, field, error });

const ALLOCATIONS: readonly VatCreditAllocation[] = ["NOT_APPLICABLE", "DIRECT_COMPUTABLE", "DIRECT_NON_COMPUTABLE", "GLOBAL_PRORATION"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function money(raw: unknown, field: string): { ok: true; value: Prisma.Decimal } | { ok: false; field: string; error: string } {
    const m = parseMoney(raw, { allowNegative: false });
    if (!m.ok) return fail(field, m.error);
    if (!moneyInRange(m.value)) return fail(field, "importe fuera de rango");
    return { ok: true, value: m.value };
}

/** Cuerpo del PATCH detallado (sólo forma; las reglas fiscales van en `buildDetailedModel`). */
export function parseDetailedEditBody(body: unknown): DetailedParse {
    if (!isObj(body)) return fail("body", "cuerpo inválido");
    if (body.contract !== DETAILED_EDIT_CONTRACT) return fail("contract", `contrato de edición detallada requerido (${DETAILED_EDIT_CONTRACT})`);
    const allowed = new Set(["contract", "expectedUpdatedAt", "voucherDate", "counterpartyName", "counterpartyVatConditionCode", "operationCode", "amounts", "reportedComputableVatCreditAmount", "vatLines"]);
    const extra = Object.keys(body).find((k) => !allowed.has(k));
    if (extra) {
        // La identidad y las clasificaciones no viajan en esta edición: nunca se aceptan en silencio.
        return fail(extra, `el campo ${extra} no se edita desde aquí (la identidad del comprobante importado es fija)`);
    }
    const expected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
    if (!expected.ok) return fail(expected.field, expected.error);
    if (typeof body.voucherDate !== "string") return fail("voucherDate", "fecha requerida (AAAA-MM-DD)");
    const date = parseIsoDateOnly(body.voucherDate);
    if (!date) return fail("voucherDate", "fecha inválida: debe ser AAAA-MM-DD y existir en el calendario");
    if (typeof body.counterpartyName !== "string" || body.counterpartyName.trim() === "") return fail("counterpartyName", "razón social de la contraparte requerida");
    const name = body.counterpartyName.trim();
    if (name.length > NAME_MAX) return fail("counterpartyName", `la razón social admite hasta ${NAME_MAX} caracteres`);
    const cond = body.counterpartyVatConditionCode;
    if (cond !== null && cond !== undefined && (typeof cond !== "number" || !VAT_CONDITIONS.some((c) => c.code === cond))) {
        return fail("counterpartyVatConditionCode", "condición fiscal de la contraparte inválida (tabla oficial de tipos de responsables)");
    }
    const op = body.operationCode;
    if (op !== null && op !== undefined && (typeof op !== "string" || !OPERATION_CODES.has(op))) return fail("operationCode", "código de operación fuera de la tabla oficial");
    if (!isObj(body.amounts)) return fail("amounts", "importes requeridos");
    const amounts = {} as Record<DetailedAmountField, Prisma.Decimal>;
    for (const f of DETAILED_AMOUNT_FIELDS) {
        const m = money(body.amounts[f] ?? "0", f);
        if (!m.ok) return m;
        amounts[f] = m.value;
    }
    const unknownAmount = Object.keys(body.amounts).find((k) => !(DETAILED_AMOUNT_FIELDS as readonly string[]).includes(k));
    if (unknownAmount) return fail(unknownAmount, `importe desconocido: ${unknownAmount}`);
    let reported: Prisma.Decimal | null = null;
    if (body.reportedComputableVatCreditAmount !== null && body.reportedComputableVatCreditAmount !== undefined) {
        const m = money(body.reportedComputableVatCreditAmount, "reportedComputableVatCreditAmount");
        if (!m.ok) return m;
        reported = m.value;
    }
    if (!Array.isArray(body.vatLines) || body.vatLines.length > 20) return fail("vatLines", "líneas de IVA requeridas (hasta 20)");
    const lines: DetailedLineInput[] = [];
    for (const [i, raw] of body.vatLines.entries()) {
        const field = `vatLines.${i}`;
        if (!isObj(raw)) return fail(field, "línea inválida");
        if (typeof raw.vatRateCode !== "number" || !VAT_RATES.some((r) => r.code === raw.vatRateCode)) return fail(`${field}.vatRateCode`, "alícuota fuera de la tabla oficial");
        const net = money(raw.netAmount, `${field}.netAmount`);
        if (!net.ok) return net;
        const vat = money(raw.vatAmount, `${field}.vatAmount`);
        if (!vat.ok) return vat;
        if (typeof raw.creditAllocation !== "string" || !ALLOCATIONS.includes(raw.creditAllocation as VatCreditAllocation)) return fail(`${field}.creditAllocation`, "atribución del crédito inválida");
        let computable: Prisma.Decimal | null = null;
        if (raw.computableVatAmount !== null && raw.computableVatAmount !== undefined) {
            const c = money(raw.computableVatAmount, `${field}.computableVatAmount`);
            if (!c.ok) return c;
            computable = c.value;
        }
        lines.push({ vatRateCode: raw.vatRateCode, netAmount: net.value, vatAmount: vat.value, creditAllocation: raw.creditAllocation as VatCreditAllocation, computableVatAmount: computable });
    }
    return {
        ok: true,
        data: {
            expectedUpdatedAt: expected.data,
            voucherDate: date,
            counterpartyName: name,
            counterpartyVatConditionCode: typeof cond === "number" ? cond : null,
            operationCode: typeof op === "string" ? op : null,
            amounts,
            reportedComputableVatCreditAmount: reported,
            vatLines: lines,
        },
    };
}

/** Datos fijos del comprobante (de la fila bloqueada). */
export interface DetailedIdentity {
    category: InvoiceCategory;
    voucherCode: number;
    pointOfSale: number;
    number: number;
    counterpartyDocType: number;
    counterpartyDocNumber: string;
    lidSection: "GENERAL" | "TURIVA";
    currencyCode: string;
    exchangeRate: Prisma.Decimal;
}

export type DetailedBuild =
    | { ok: true; model: InvoiceModelData; warnings: InvoiceWarning[] }
    | { ok: false; field: string; error: string };

/** Modelo contable a guardar, con las reglas de la importación. */
export function buildDetailedModel(
    id: DetailedIdentity,
    input: DetailedEditInput,
    period: { month: number; year: number },
    settings: PeriodVatSettingsLike,
): DetailedBuild {
    const { category } = id;
    const vt = voucherType(id.voucherCode);
    const a = input.amounts;

    const date = checkVoucherDate(category, input.voucherDate, period);
    if (!date.ok) return fail("voucherDate", date.error);

    // Líneas de IVA.
    const noBreakdown = purchaseHasNoVatBreakdown(category, id.voucherCode);
    if (noBreakdown && input.vatLines.length > 0) return fail("vatLines", "un comprobante B o C de compras no discrimina IVA: no lleva líneas de alícuota");
    const seen = new Set<string>();
    const mode = String(settings.creditProrationMode);
    const lines: VatLineData[] = [];
    for (const [i, l] of input.vatLines.entries()) {
        const field = `vatLines.${i}`;
        const k = `${l.vatRateCode}|${l.creditAllocation}`;
        if (seen.has(k)) return fail(field, "la misma alícuota y atribución aparece dos veces: unificá las líneas");
        seen.add(k);
        if (l.vatAmount.greaterThan(l.netAmount) && input.operationCode !== "C") return fail(`${field}.vatAmount`, "el IVA de la línea supera al neto gravado");
        const computed = computeLineVat(l.netAmount, l.vatRateCode);
        if (computed.minus(l.vatAmount).abs().greaterThan(VAT_TOLERANCE)) {
            return fail(`${field}.vatAmount`, `el IVA ${l.vatAmount.toFixed(2)} no corresponde a la alícuota: calculado ${computed.toFixed(2)} (tolerancia 0,01)`);
        }
        if (l.vatRateCode === 3 && input.operationCode === null) return fail("operationCode", "una línea al 0 % requiere el código de operación");
        if (category === "PURCHASES") {
            if (l.creditAllocation === "GLOBAL_PRORATION" && mode !== "GLOBAL" && mode !== "DIRECT_AND_GLOBAL") return fail(`${field}.creditAllocation`, "el período no tiene prorrateo global");
            if (l.creditAllocation === "DIRECT_NON_COMPUTABLE" && mode === "NONE") return fail(`${field}.creditAllocation`, "en un período sin prorrateo el crédito de la línea es computable");
            if (l.creditAllocation === "DIRECT_COMPUTABLE" && mode === "NONE" && (l.computableVatAmount === null || !l.computableVatAmount.equals(l.vatAmount))) {
                return fail(`${field}.computableVatAmount`, "en un período sin prorrateo el crédito computable es igual al IVA de la línea");
            }
        }
        const line: VatLineData = {
            vatRateCode: l.vatRateCode,
            netAmount: l.netAmount,
            vatAmount: l.vatAmount,
            creditAllocation: l.creditAllocation,
            computableVatAmount: l.computableVatAmount,
            computableOverridden: l.creditAllocation === "DIRECT_COMPUTABLE" && l.computableVatAmount !== null && !l.computableVatAmount.equals(l.vatAmount),
        };
        const err = vatLineError(category, line);
        if (err) return fail(field, err);
        lines.push(line);
    }

    // Neto sin discriminar: sólo compras B/C o ventas C, sin líneas.
    const allowsNoBreakdownNet = lines.length === 0 && (noBreakdown || (category === "SALES" && vt.letter === "C"));
    if (!allowsNoBreakdownNet && !a.netWithoutVatBreakdownAmount.isZero()) {
        return fail("netWithoutVatBreakdownAmount", "el neto sin IVA discriminado sólo corresponde a compras B/C o ventas C sin líneas de alícuota");
    }
    if (lines.length === 0 && !noBreakdown && !(category === "SALES" && vt.letter === "C") && a.exemptAmount.isZero() && a.nonTaxedAmount.isZero()) {
        return fail("vatLines", "el comprobante discrimina IVA: agregá al menos una línea de alícuota (o informá el importe exento o no gravado)");
    }
    if (id.lidSection !== "TURIVA" && !a.turivaRefundAmount.isZero()) return fail("turivaRefundAmount", "el reintegro TurIVA sólo corresponde a comprobantes de la pestaña TURIVA");

    const amounts: VoucherAmounts = {
        taxedNetAmount: sum(lines.map((l) => l.netAmount)),
        totalVatAmount: sum(lines.map((l) => l.vatAmount)),
        netWithoutVatBreakdownAmount: a.netWithoutVatBreakdownAmount,
        nonTaxedAmount: a.nonTaxedAmount,
        exemptAmount: a.exemptAmount,
        vatPerceptionAmount: a.vatPerceptionAmount,
        nationalPerceptionAmount: a.nationalPerceptionAmount,
        iibbPerceptionAmount: a.iibbPerceptionAmount,
        municipalPerceptionAmount: a.municipalPerceptionAmount,
        internalTaxesAmount: a.internalTaxesAmount,
        otherTaxesAmount: a.otherTaxesAmount,
    };
    const total = computeVoucherTotal(amounts);
    if (!moneyInRange(total)) return fail("totalAmount", "el total calculado queda fuera de rango");
    if (total.isZero() && lines.length === 0) return fail("amounts", "el comprobante no tiene importes");

    let reported: Prisma.Decimal | null = null;
    if (category === "PURCHASES") {
        reported = input.reportedComputableVatCreditAmount;
        if (reported !== null && reported.greaterThan(amounts.totalVatAmount)) {
            return fail("reportedComputableVatCreditAmount", "el crédito computable informado supera al IVA del comprobante");
        }
    } else if (input.reportedComputableVatCreditAmount !== null) {
        return fail("reportedComputableVatCreditAmount", "en ventas no hay crédito computable informado");
    }

    return {
        ok: true,
        warnings: date.warnings,
        model: {
            ...amounts,
            category,
            voucherCode: id.voucherCode,
            pointOfSale: id.pointOfSale,
            number: id.number,
            voucherDate: input.voucherDate,
            counterpartyDocType: id.counterpartyDocType,
            counterpartyDocNumber: id.counterpartyDocNumber,
            counterpartyName: input.counterpartyName,
            currencyCode: id.currencyCode,
            exchangeRate: id.exchangeRate,
            directComputableVatCreditAmount: category === "PURCHASES" ? directComputableOf(lines) : ZERO,
            reportedComputableVatCreditAmount: reported,
            grossIncomeTaxBaseAmount: category === "SALES" ? amounts.taxedNetAmount.plus(amounts.netWithoutVatBreakdownAmount) : null,
            voucherTotalAmount: total,
            turivaRefundAmount: a.turivaRefundAmount,
            lidSection: id.lidSection,
            operationCode: input.operationCode,
            vatLines: lines,
        },
    };
}

/** Fila actual en la misma forma que el modelo, para comparar. */
export interface DetailedCurrent {
    voucherDate: Date | null;
    counterpartyName: string | null;
    counterpartyVatConditionCode: number | null;
    operationCode: string | null;
    reportedComputableVatCreditAmount: Prisma.Decimal | null;
    amounts: Record<DetailedAmountField, Prisma.Decimal | null>;
    vatLines: Array<{ vatRateCode: number; netAmount: Prisma.Decimal; vatAmount: Prisma.Decimal; creditAllocation: string; computableVatAmount: Prisma.Decimal | null }>;
}

/** Nombres (nunca valores) de los campos que cambian. Vacío = sin cambios. */
export function detailedChangedFields(before: DetailedCurrent, input: DetailedEditInput, model: InvoiceModelData): string[] {
    const out: string[] = [];
    const eq = (x: Prisma.Decimal | null, y: Prisma.Decimal | null) => (x === null || y === null ? x === y : x.equals(y));
    if (before.voucherDate?.toISOString().slice(0, 10) !== model.voucherDate.toISOString().slice(0, 10)) out.push("voucherDate");
    if ((before.counterpartyName ?? "") !== model.counterpartyName) out.push("counterpartyName");
    if (before.counterpartyVatConditionCode !== input.counterpartyVatConditionCode) out.push("counterpartyVatConditionCode");
    if (before.operationCode !== model.operationCode) out.push("operationCode");
    if (!eq(before.reportedComputableVatCreditAmount, model.reportedComputableVatCreditAmount)) out.push("reportedComputableVatCreditAmount");
    for (const f of DETAILED_AMOUNT_FIELDS) {
        const after = f === "netWithoutVatBreakdownAmount" ? model.netWithoutVatBreakdownAmount : input.amounts[f];
        if (!eq(before.amounts[f] ?? ZERO, after)) out.push(f);
    }
    const norm = (ls: DetailedCurrent["vatLines"]) =>
        ls.map((l) => `${l.vatRateCode}|${l.creditAllocation}|${l.netAmount.toFixed(2)}|${l.vatAmount.toFixed(2)}|${l.computableVatAmount?.toFixed(2) ?? "-"}`).sort().join(";");
    if (norm(before.vatLines) !== norm(model.vatLines)) out.push("vatLines");
    return out;
}
