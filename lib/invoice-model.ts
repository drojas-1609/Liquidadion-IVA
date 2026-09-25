import "server-only";
import { Prisma } from "@prisma/client";
import { D, ZERO, sum, roundMoney, computeVatAmount } from "./decimal";
import {
    VAT_RATES,
    VOUCHER_TYPES,
    DOC_TYPE_CUIT,
    CURRENCY_PESOS,
    RULE_PURCHASES_BC_NO_VAT_LINES,
    type VoucherTypeEntry,
} from "./arca/catalogs";

/**
 * Modelo contable de comprobantes (Fase A).
 *
 * ÚNICA fuente de:
 *  - el signo contable (`voucherSign`, sólo por código oficial de comprobante);
 *  - el IVA de una línea (`computeLineVat`, HALF_UP a 2 decimales vía lib/decimal);
 *  - el total del comprobante (`computeVoucherTotal`);
 *  - la atribución del crédito fiscal por línea y el crédito directo;
 *  - el crédito por prorrateo global (`computeProratedCredit`);
 *  - la regla de la pestaña TURIVA (`lidSectionError`);
 *  - la lectura compatible de filas heredadas (`normalizeInvoiceRow`);
 *  - la escritura de las columnas heredadas (`legacyColumnsFor`).
 *
 * Importes del modelo nuevo: SIEMPRE positivos y en pesos.
 */

export type InvoiceCategory = "SALES" | "PURCHASES";
export type VatCreditAllocation =
    | "NOT_APPLICABLE"
    | "DIRECT_COMPUTABLE"
    | "DIRECT_NON_COMPUTABLE"
    | "GLOBAL_PRORATION";
export type LidSection = "GENERAL" | "TURIVA";
export type CreditProrationMode = "NONE" | "DIRECT" | "GLOBAL" | "DIRECT_AND_GLOBAL";

export class UnknownCatalogCodeError extends Error {
    constructor(what: string, code: unknown) {
        super(`${what} desconocido en el catálogo oficial: ${String(code)}`);
        this.name = "UnknownCatalogCodeError";
    }
}

/** Mensaje exacto (aprobado) cuando falta el coeficiente de prorrateo global. */
export const MISSING_GLOBAL_COEFFICIENT_MESSAGE = "Falta configurar el coeficiente de prorrateo global del período.";

/**
 * La liquidación falla CERRADA: hay líneas GLOBAL_PRORATION y el período no
 * tiene coeficiente global configurado. Nunca se asume 0 ni 1.
 */
export class MissingGlobalProrationCoefficientError extends Error {
    constructor() {
        super(MISSING_GLOBAL_COEFFICIENT_MESSAGE);
        this.name = "MissingGlobalProrationCoefficientError";
    }
}

// ── Catálogos ─────────────────────────────────────────────────────────────

export function voucherType(code: number): VoucherTypeEntry {
    const entry = VOUCHER_TYPES.find((v) => v.code === code);
    if (!entry) throw new UnknownCatalogCodeError("Tipo de comprobante", code);
    return entry;
}

/**
 * Signo contable del comprobante: −1 para notas de crédito, +1 para facturas y
 * notas de débito. Depende EXCLUSIVAMENTE del código oficial; un código fuera
 * del catálogo lanza (nunca se asume un signo).
 */
export function voucherSign(code: number): 1 | -1 {
    return voucherType(code).kind === "CREDIT_NOTE" ? -1 : 1;
}

export function voucherTypeByLegacyLabel(label: string): VoucherTypeEntry | null {
    return VOUCHER_TYPES.find((v) => v.legacyLabel === label.trim()) ?? null;
}

/** Porcentaje de una alícuota oficial. Código desconocido -> lanza. */
export function vatRateOf(code: number): Prisma.Decimal {
    const entry = VAT_RATES.find((r) => r.code === code);
    if (!entry) throw new UnknownCatalogCodeError("Código de alícuota", code);
    return D(entry.rate);
}

/** Código oficial para un porcentaje exacto, o null si no está en la tabla. */
export function vatRateCodeFor(rate: Prisma.Decimal): number | null {
    return VAT_RATES.find((r) => D(r.rate).equals(rate))?.code ?? null;
}

/**
 * IVA de una línea para CARGA MANUAL: HALF_UP(neto × alícuota / 100, 2), por
 * línea. (La importación futura conservará el IVA informado y validará la
 * diferencia contra este cálculo.)
 */
export function computeLineVat(netAmount: Prisma.Decimal, vatRateCode: number): Prisma.Decimal {
    return computeVatAmount(netAmount, vatRateOf(vatRateCode));
}

/**
 * Compras con comprobante que no discrimina IVA (tipo 'B' o 'C'): cero líneas
 * de IVA (Especificaciones Libro IVA Digital, Libro Compras, campo 19).
 */
export function purchaseHasNoVatBreakdown(category: InvoiceCategory, voucherCode: number): boolean {
    if (category !== "PURCHASES") return false;
    return (RULE_PURCHASES_BC_NO_VAT_LINES.letters as readonly string[]).includes(voucherType(voucherCode).letter);
}

// ── Atribución del crédito fiscal por línea ──────────────────────────────

export interface VatLineData {
    vatRateCode: number;
    netAmount: Prisma.Decimal;
    /** IVA facturado. */
    vatAmount: Prisma.Decimal;
    creditAllocation: VatCreditAllocation;
    /** DIRECT_COMPUTABLE: 0..vatAmount · DIRECT_NON_COMPUTABLE: 0 · resto: NULL. */
    computableVatAmount: Prisma.Decimal | null;
    computableOverridden: boolean;
}

/** Computable por defecto según la atribución (sin corrección manual). */
export function defaultComputableVat(
    allocation: VatCreditAllocation,
    vatAmount: Prisma.Decimal,
): Prisma.Decimal | null {
    switch (allocation) {
        case "DIRECT_COMPUTABLE":
            return vatAmount;
        case "DIRECT_NON_COMPUTABLE":
            return ZERO;
        case "GLOBAL_PRORATION":
        case "NOT_APPLICABLE":
            return null;
    }
}

/** Valida una línea contra su categoría y atribución. null = válida. */
export function vatLineError(category: InvoiceCategory, line: VatLineData): string | null {
    if (line.netAmount.isNegative() || line.vatAmount.isNegative()) return "los importes de la línea no pueden ser negativos";
    const c = line.computableVatAmount;
    if (category === "SALES") {
        if (line.creditAllocation !== "NOT_APPLICABLE") return "en ventas la atribución del crédito debe ser NOT_APPLICABLE";
        if (c !== null) return "en ventas la línea no tiene crédito computable";
        if (line.computableOverridden) return "en ventas no hay crédito computable que corregir";
        return null;
    }
    switch (line.creditAllocation) {
        case "NOT_APPLICABLE":
            return "en compras la atribución del crédito no puede ser NOT_APPLICABLE";
        case "DIRECT_COMPUTABLE":
            if (c === null || c.isNegative() || c.greaterThan(line.vatAmount)) {
                return "el crédito computable directo debe estar entre 0 y el IVA de la línea";
            }
            return null;
        case "DIRECT_NON_COMPUTABLE":
            if (c === null || !c.isZero()) return "una línea no computable tiene crédito computable 0";
            if (line.computableOverridden) return "una línea no computable no admite corrección";
            return null;
        case "GLOBAL_PRORATION":
            if (c !== null) return "una línea sujeta a prorrateo global no guarda crédito computable";
            if (line.computableOverridden) return "una línea sujeta a prorrateo global no admite corrección";
            return null;
    }
}

/** Crédito computable DIRECTO: Σ computableVatAmount de las líneas DIRECT_COMPUTABLE. */
export function directComputableOf(
    lines: readonly Pick<VatLineData, "creditAllocation" | "computableVatAmount">[],
): Prisma.Decimal {
    return sum(
        lines
            .filter((l) => l.creditAllocation === "DIRECT_COMPUTABLE")
            .map((l) => l.computableVatAmount ?? ZERO),
    );
}

/** IVA facturado sujeto a prorrateo global: Σ vatAmount de las líneas GLOBAL_PRORATION. */
export function globalProrationVatOf(
    lines: readonly Pick<VatLineData, "creditAllocation" | "vatAmount">[],
): Prisma.Decimal {
    return sum(lines.filter((l) => l.creditAllocation === "GLOBAL_PRORATION").map((l) => l.vatAmount));
}

// ── Prorrateo global (por período) ───────────────────────────────────────

export interface PeriodVatSettingsLike {
    creditProrationMode: CreditProrationMode | string;
    globalCoefficient: Prisma.Decimal | null;
    turivaIncluded?: boolean;
}

/** Sin configuración: modalidad NONE, TurIVA desactivado, sin coeficiente. */
export const DEFAULT_PERIOD_VAT_SETTINGS: PeriodVatSettingsLike = {
    creditProrationMode: "NONE",
    globalCoefficient: null,
    turivaIncluded: false,
};

/**
 * Coeficiente global utilizable, o null si la modalidad no incluye prorrateo
 * global o no hay coeficiente.
 */
export function globalCoefficientOf(settings: PeriodVatSettingsLike | null | undefined): Prisma.Decimal | null {
    const s = settings ?? DEFAULT_PERIOD_VAT_SETTINGS;
    if (s.creditProrationMode !== "GLOBAL" && s.creditProrationMode !== "DIRECT_AND_GLOBAL") return null;
    return s.globalCoefficient ?? null;
}

/**
 * Crédito por prorrateo global = HALF_UP(coeficiente × IVA sujeto a prorrateo del
 * PERÍODO, 2). Se redondea UNA sola vez, sobre el total del período (no por
 * comprobante ni por línea). Las líneas no guardan este resultado.
 */
export function computeProratedCredit(coefficient: Prisma.Decimal, globalProrationVat: Prisma.Decimal): Prisma.Decimal {
    return roundMoney(D(coefficient).times(D(globalProrationVat)));
}

// ── TurIVA ────────────────────────────────────────────────────────────────

export const TURIVA_NOT_INCLUDED_MESSAGE =
    "El período no está incluido en el Régimen TurIVA: no se puede registrar el comprobante en la pestaña TURIVA.";

/** La pestaña TURIVA exige que el período esté "Incluido en el Régimen TurIVA". */
export function lidSectionError(section: LidSection, settings: PeriodVatSettingsLike | null | undefined): string | null {
    if (section === "TURIVA" && !(settings ?? DEFAULT_PERIOD_VAT_SETTINGS).turivaIncluded) {
        return TURIVA_NOT_INCLUDED_MESSAGE;
    }
    return null;
}

// ── Totales ───────────────────────────────────────────────────────────────

export interface VoucherAmounts {
    taxedNetAmount: Prisma.Decimal;
    totalVatAmount: Prisma.Decimal;
    netWithoutVatBreakdownAmount: Prisma.Decimal;
    nonTaxedAmount: Prisma.Decimal;
    exemptAmount: Prisma.Decimal;
    vatPerceptionAmount: Prisma.Decimal;
    nationalPerceptionAmount: Prisma.Decimal;
    iibbPerceptionAmount: Prisma.Decimal;
    municipalPerceptionAmount: Prisma.Decimal;
    internalTaxesAmount: Prisma.Decimal;
    otherTaxesAmount: Prisma.Decimal;
}

/**
 * Total del comprobante (positivo, en pesos):
 *   taxedNet + totalVat + netWithoutVatBreakdown + nonTaxed + exempt
 *   + vatPerception + nationalPerception + iibbPerception + municipalPerception
 *   + internalTaxes + otherTaxes
 * El reintegro TurIVA (Decreto 1043/2016) NO forma parte del total.
 * Suma exacta de valores de escala 2: no se redondea.
 */
export function computeVoucherTotal(a: VoucherAmounts): Prisma.Decimal {
    return sum([
        a.taxedNetAmount,
        a.totalVatAmount,
        a.netWithoutVatBreakdownAmount,
        a.nonTaxedAmount,
        a.exemptAmount,
        a.vatPerceptionAmount,
        a.nationalPerceptionAmount,
        a.iibbPerceptionAmount,
        a.municipalPerceptionAmount,
        a.internalTaxesAmount,
        a.otherTaxesAmount,
    ]);
}

// ── Modelo completo de un comprobante ─────────────────────────────────────

export interface InvoiceModelData extends VoucherAmounts {
    category: InvoiceCategory;
    voucherCode: number;
    pointOfSale: number;
    number: number;
    voucherDate: Date;
    counterpartyDocType: number;
    counterpartyDocNumber: string;
    counterpartyName: string;
    currencyCode: string;
    exchangeRate: Prisma.Decimal;
    /** Σ computable de las líneas DIRECT_COMPUTABLE (0 en ventas). */
    directComputableVatCreditAmount: Prisma.Decimal;
    /** Crédito computable informado oficialmente (importación); NULL en carga manual. */
    reportedComputableVatCreditAmount: Prisma.Decimal | null;
    /** Sólo ventas; NULL en compras. */
    grossIncomeTaxBaseAmount: Prisma.Decimal | null;
    voucherTotalAmount: Prisma.Decimal;
    /** Reintegro TurIVA; separado del total. */
    turivaRefundAmount: Prisma.Decimal;
    lidSection: LidSection;
    operationCode: string | null;
    vatLines: VatLineData[];
}

/** `NN-NNNNNNNN-N` a partir de 11 dígitos. */
function formatCuitDigits(digits: string): string {
    return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

export interface LegacyColumns {
    date: Date;
    type: string;
    entityName: string;
    /** CUIT formateado; si el documento no es CUIT, el número (compatibilidad transitoria). */
    entityCuit: string;
    /** Porcentaje si hay exactamente una alícuota; 0 sin líneas; NULL con varias. */
    vatRate: Prisma.Decimal | null;
    netAmount: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
}

/**
 * Columnas HEREDADAS con su semántica anterior (importes con signo), para que
 * el código publicado anterior liquide igual que el nuevo:
 *   netAmount   = s × (taxedNet + netWithoutVatBreakdown)   (base IIBB anterior)
 *   vatAmount   = s × totalVat (ventas) | s × crédito DIRECTO (compras)
 *   totalAmount = s × voucherTotal
 * El prorrateo global no es representable en las columnas heredadas (el código
 * anterior no lo conoce); este PR no crea líneas GLOBAL_PRORATION.
 */
export function legacyColumnsFor(m: InvoiceModelData): LegacyColumns {
    const s = voucherSign(m.voucherCode);
    const rates = new Set(m.vatLines.map((l) => l.vatRateCode));
    const vatRate = rates.size === 1 ? vatRateOf([...rates][0]) : rates.size === 0 ? ZERO : null;
    return {
        date: m.voucherDate,
        type: voucherType(m.voucherCode).legacyLabel,
        entityName: m.counterpartyName,
        entityCuit:
            m.counterpartyDocType === DOC_TYPE_CUIT && /^\d{11}$/.test(m.counterpartyDocNumber)
                ? formatCuitDigits(m.counterpartyDocNumber)
                : m.counterpartyDocNumber,
        vatRate,
        netAmount: m.taxedNetAmount.plus(m.netWithoutVatBreakdownAmount).times(s),
        vatAmount: (m.category === "SALES" ? m.totalVatAmount : m.directComputableVatCreditAmount).times(s),
        totalAmount: m.voucherTotalAmount.times(s),
    };
}

// ── Alta con el contrato anterior de /api/invoices (una sola alícuota) ────

export interface LegacyInvoiceInput {
    category: InvoiceCategory;
    type: string;
    date: Date;
    pointOfSale: number;
    number: number;
    entityName: string;
    /** CUIT canónico `NN-NNNNNNNN-N`. */
    entityCuit: string;
    /** Neto informado; una nota de crédito puede venir con signo negativo. */
    netAmount: Prisma.Decimal;
    vatRate: Prisma.Decimal;
}

export type LegacyInputResult =
    | { ok: true; model: InvoiceModelData }
    | { ok: false; field: string; error: string };

/**
 * Traduce el cuerpo del formulario actual (una alícuota) al modelo contable.
 * Rechaza lo que no se puede representar sin falsear su naturaleza fiscal.
 * Compras: la línea queda DIRECT_COMPUTABLE (criterio anterior: todo el IVA
 * es crédito); ventas: NOT_APPLICABLE. Pestaña GENERAL.
 */
export function modelFromLegacyInput(input: LegacyInvoiceInput): LegacyInputResult {
    const vt = voucherTypeByLegacyLabel(input.type);
    if (!vt) return { ok: false, field: "type", error: "tipo de comprobante no reconocido en el catálogo oficial" };
    const s = voucherSign(vt.code);

    if (s === 1 && input.netAmount.isNegative()) {
        return { ok: false, field: "netAmount", error: "una factura o nota de débito no admite importes negativos" };
    }
    const net = input.netAmount.abs();

    const rateCode = vatRateCodeFor(input.vatRate);
    if (rateCode === null) {
        return { ok: false, field: "vatRate", error: "alícuota no incluida en la tabla oficial de ARCA" };
    }

    const noBreakdown = purchaseHasNoVatBreakdown(input.category, vt.code);
    if (noBreakdown && !input.vatRate.isZero()) {
        return {
            ok: false,
            field: "vatRate",
            error: "los comprobantes B y C de compras no discriminan IVA: la alícuota debe ser 0",
        };
    }

    const allocation: VatCreditAllocation = input.category === "PURCHASES" ? "DIRECT_COMPUTABLE" : "NOT_APPLICABLE";
    const vatLines: VatLineData[] = [];
    if (!noBreakdown) {
        const vat = computeLineVat(net, rateCode);
        vatLines.push({
            vatRateCode: rateCode,
            netAmount: net,
            vatAmount: vat,
            creditAllocation: allocation,
            computableVatAmount: defaultComputableVat(allocation, vat),
            computableOverridden: false,
        });
    }

    const amounts: VoucherAmounts = {
        taxedNetAmount: sum(vatLines.map((l) => l.netAmount)),
        totalVatAmount: sum(vatLines.map((l) => l.vatAmount)),
        netWithoutVatBreakdownAmount: noBreakdown ? net : ZERO,
        nonTaxedAmount: ZERO,
        exemptAmount: ZERO,
        vatPerceptionAmount: ZERO,
        nationalPerceptionAmount: ZERO,
        iibbPerceptionAmount: ZERO,
        municipalPerceptionAmount: ZERO,
        internalTaxesAmount: ZERO,
        otherTaxesAmount: ZERO,
    };

    return {
        ok: true,
        model: {
            ...amounts,
            category: input.category,
            voucherCode: vt.code,
            pointOfSale: input.pointOfSale,
            number: input.number,
            voucherDate: input.date,
            counterpartyDocType: DOC_TYPE_CUIT,
            counterpartyDocNumber: input.entityCuit.replace(/\D/g, ""),
            counterpartyName: input.entityName,
            currencyCode: CURRENCY_PESOS,
            exchangeRate: D(1),
            directComputableVatCreditAmount: directComputableOf(vatLines),
            reportedComputableVatCreditAmount: null,
            // Preserva el criterio anterior (base = neto de ventas); corregible en la fase B.
            grossIncomeTaxBaseAmount:
                input.category === "SALES" ? amounts.taxedNetAmount.plus(amounts.netWithoutVatBreakdownAmount) : null,
            voucherTotalAmount: computeVoucherTotal(amounts),
            turivaRefundAmount: ZERO,
            lidSection: "GENERAL",
            operationCode: null,
            vatLines,
        },
    };
}

// ── Lectura compatible ────────────────────────────────────────────────────

/** Forma mínima de una fila de Invoice (columnas nuevas opcionales/nullable). */
export interface InvoiceRowLike {
    category: string;
    netAmount: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    date?: Date | null;
    type?: string | null;
    entityName?: string | null;
    voucherCode?: number | null;
    voucherDate?: Date | null;
    counterpartyName?: string | null;
    taxedNetAmount?: Prisma.Decimal | null;
    totalVatAmount?: Prisma.Decimal | null;
    netWithoutVatBreakdownAmount?: Prisma.Decimal | null;
    directComputableVatCreditAmount?: Prisma.Decimal | null;
    grossIncomeTaxBaseAmount?: Prisma.Decimal | null;
    voucherTotalAmount?: Prisma.Decimal | null;
    /** Necesarias para liquidar compras modeladas (prorrateo global). */
    vatLines?: ReadonlyArray<{ vatAmount: Prisma.Decimal; creditAllocation: string }>;
}

export interface NormalizedInvoice {
    /** MODELED: columnas nuevas completas. LEGACY: fila anterior sin representar. */
    mode: "MODELED" | "LEGACY";
    category: string;
    voucherCode: number | null;
    voucherLabel: string;
    /** Fecha contable `AAAA-MM-DD`, sin zona horaria. */
    voucherDate: string | null;
    counterpartyName: string;
    /** Importes con signo contable, para pantallas y totales. */
    signedNet: Prisma.Decimal;
    signedVat: Prisma.Decimal;
    signedTotal: Prisma.Decimal;
    /** Débito fiscal (con signo). */
    vatDebit: Prisma.Decimal;
    /** Crédito computable DIRECTO (con signo). */
    vatDirectCredit: Prisma.Decimal;
    /**
     * IVA sujeto a prorrateo global (con signo). null = compra modelada cuyas
     * líneas no se cargaron: la liquidación falla cerrada.
     */
    globalProrationVat: Prisma.Decimal | null;
    /** ¿Tiene al menos una línea GLOBAL_PRORATION? null si no se cargaron las líneas. */
    hasGlobalProrationLines: boolean | null;
    grossIncomeTaxBase: Prisma.Decimal;
}

function isModeled(r: InvoiceRowLike): boolean {
    return (
        r.voucherCode != null &&
        r.taxedNetAmount != null &&
        r.totalVatAmount != null &&
        r.netWithoutVatBreakdownAmount != null &&
        r.directComputableVatCreditAmount != null &&
        r.voucherTotalAmount != null &&
        (r.category !== "SALES" || r.grossIncomeTaxBaseAmount != null)
    );
}

/** `@db.Date` llega como medianoche UTC: se toma el día UTC, nunca el local. */
export function isoDate(d: Date | null | undefined): string | null {
    return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Vista única de un comprobante para cálculo y pantallas.
 *  - MODELED: signo por `voucherSign`; crédito directo = directComputable;
 *    IVA sujeto a prorrateo = Σ líneas GLOBAL_PRORATION; base IIBB =
 *    `grossIncomeTaxBaseAmount`.
 *  - LEGACY (`voucherCode` NULL o columnas nuevas incompletas): reproduce
 *    EXACTAMENTE el cálculo anterior con las columnas heredadas con signo.
 */
export function normalizeInvoiceRow(r: InvoiceRowLike): NormalizedInvoice {
    const isSales = r.category === "SALES";
    const isPurchase = r.category === "PURCHASES";

    if (isModeled(r)) {
        const code = r.voucherCode as number;
        const s = voucherSign(code);
        const totalVat = r.totalVatAmount as Prisma.Decimal;
        let globalProrationVat: Prisma.Decimal | null = ZERO;
        let hasGlobal: boolean | null = false;
        if (isPurchase) {
            if (r.vatLines === undefined) {
                globalProrationVat = null;
                hasGlobal = null;
            } else {
                const globalLines = r.vatLines.filter((l) => l.creditAllocation === "GLOBAL_PRORATION");
                hasGlobal = globalLines.length > 0;
                globalProrationVat = sum(globalLines.map((l) => l.vatAmount)).times(s);
            }
        }
        return {
            mode: "MODELED",
            category: r.category,
            voucherCode: code,
            voucherLabel: voucherType(code).legacyLabel,
            voucherDate: isoDate(r.voucherDate ?? r.date),
            counterpartyName: r.counterpartyName ?? r.entityName ?? "",
            signedNet: (r.taxedNetAmount as Prisma.Decimal)
                .plus(r.netWithoutVatBreakdownAmount as Prisma.Decimal)
                .times(s),
            signedVat: totalVat.times(s),
            signedTotal: (r.voucherTotalAmount as Prisma.Decimal).times(s),
            vatDebit: isSales ? totalVat.times(s) : ZERO,
            vatDirectCredit: isPurchase ? (r.directComputableVatCreditAmount as Prisma.Decimal).times(s) : ZERO,
            globalProrationVat,
            hasGlobalProrationLines: hasGlobal,
            grossIncomeTaxBase: isSales ? (r.grossIncomeTaxBaseAmount as Prisma.Decimal).times(s) : ZERO,
        };
    }

    return {
        mode: "LEGACY",
        category: r.category,
        voucherCode: null,
        voucherLabel: r.type ?? "—",
        voucherDate: isoDate(r.date),
        counterpartyName: r.entityName ?? "",
        signedNet: D(r.netAmount),
        signedVat: D(r.vatAmount),
        signedTotal: D(r.totalAmount),
        vatDebit: isSales ? D(r.vatAmount) : ZERO,
        vatDirectCredit: isPurchase ? D(r.vatAmount) : ZERO,
        globalProrationVat: ZERO,
        hasGlobalProrationLines: false,
        grossIncomeTaxBase: isSales ? D(r.netAmount) : ZERO,
    };
}
