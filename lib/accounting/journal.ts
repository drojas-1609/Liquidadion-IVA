import { Prisma } from "@prisma/client";
import { D, sum, sub, roundMoney, ZERO, type Decimalish } from "../decimal";
import type { AccountRole } from "./chart-models";

/**
 * Asientos automáticos del libro diario (Fase C2b). Funciones puras: arman las
 * líneas por ROL de cuenta (el servicio resuelve cada rol a la cuenta del plan
 * del cliente). Una línea con importe negativo pasa al otro lado; las de
 * importe cero no se graban. Todo asiento debe cuadrar (Debe = Haber).
 */

export const JOURNAL_KINDS = ["VAT_POSITION", "IIBB_POSITION", "TAX_PAYMENT"] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];
export const JOURNAL_KIND_LABEL: Record<JournalKind, string> = {
    VAT_POSITION: "Liquidación de IVA",
    IIBB_POSITION: "DDJJ de Ingresos Brutos",
    TAX_PAYMENT: "Pago de impuesto",
};

/** Línea por rol (asientos automáticos) o por cuenta elegida (cuenta de pago). */
export interface DraftLine {
    role?: AccountRole;
    accountId?: string;
    debit: Prisma.Decimal;
    credit: Prisma.Decimal;
    memo: string;
}

export interface DraftEntry {
    kind: JournalKind;
    date: string; // aaaa-mm-dd
    description: string;
    lines: DraftLine[];
}

type Target = { role: AccountRole } | { accountId: string };

function line(target: Target, side: "D" | "H", amount: Decimalish, memo: string): DraftLine | null {
    const a = roundMoney(amount);
    if (a.isZero()) return null;
    // Negativo: pasa al otro lado con el importe absoluto.
    const debitSide = (side === "D") !== a.isNegative();
    const abs = a.abs();
    return { ...target, debit: debitSide ? abs : ZERO, credit: debitSide ? ZERO : abs, memo };
}

function compact(lines: (DraftLine | null)[]): DraftLine[] {
    return lines.filter((l): l is DraftLine => l !== null);
}

export function totals(lines: readonly { debit: Prisma.Decimal; credit: Prisma.Decimal }[]): { debit: Prisma.Decimal; credit: Prisma.Decimal } {
    return { debit: sum(lines.map((l) => l.debit)), credit: sum(lines.map((l) => l.credit)) };
}

export class UnbalancedEntryError extends Error {
    constructor(debit: Prisma.Decimal, credit: Prisma.Decimal) {
        super(`El asiento no cuadra: Debe ${debit.toFixed(2)} ≠ Haber ${credit.toFixed(2)}.`);
    }
}

export function assertBalanced(entry: DraftEntry): void {
    const t = totals(entry.lines);
    if (!t.debit.equals(t.credit)) throw new UnbalancedEntryError(t.debit, t.credit);
    if (entry.lines.length === 0) throw new Error("El asiento no tiene importes.");
}

/** Último día del mes (fecha del asiento de cierre de la posición mensual). */
export function lastDayOfMonth(year: number, month: number): string {
    const d = new Date(Date.UTC(year, month, 0));
    return d.toISOString().slice(0, 10);
}

const pp = (month: number, year: number) => `${String(month).padStart(2, "0")}/${year}`;

/** Posición mensual de IVA (campos de LiquidationResult.iva). */
export interface VatPosition {
    debit: Decimalish;
    creditPurchases: Decimalish;
    creditSocialSecurityAnnexI: Decimalish;
    creditSocialSecurityArt91: Decimalish;
    previousTechnicalBalance: Decimalish;
    technicalBalanceInFavor: Decimalish;
    withholdings: Decimalish;
    perceptions: Decimalish;
    customsPerceptions: Decimalish;
    previousFreeBalance: Decimalish;
    balanceToPay: Decimalish;
    freeBalanceInFavor: Decimalish;
}

/**
 * Cierre de la posición de IVA del período:
 *  Debe  IVA débito fiscal
 *  Haber IVA crédito fiscal (compras y contribuciones a la Seguridad Social)
 *  Haber saldo técnico anterior · saldo de libre disponibilidad anterior
 *  Haber retenciones y percepciones de IVA
 *  Debe  saldo técnico a favor del período · libre disponibilidad a favor
 *  Haber IVA a pagar
 */
export function buildVatEntry(iva: VatPosition, month: number, year: number): DraftEntry {
    const p = pp(month, year);
    const ss = sum([iva.creditSocialSecurityAnnexI, iva.creditSocialSecurityArt91]);
    const entry: DraftEntry = {
        kind: "VAT_POSITION",
        date: lastDayOfMonth(year, month),
        description: `Liquidación de IVA ${p}`,
        lines: compact([
            line({ role: "VAT_DEBIT" }, "D", iva.debit, "Débito fiscal del período"),
            line({ role: "VAT_TECH_BALANCE" }, "D", iva.technicalBalanceInFavor, "Saldo técnico a favor que se traslada"),
            line({ role: "VAT_FREE_BALANCE" }, "D", iva.freeBalanceInFavor, "Saldo de libre disponibilidad a favor"),
            line({ role: "VAT_CREDIT" }, "H", iva.creditPurchases, "Crédito fiscal por compras"),
            line({ role: "VAT_CREDIT" }, "H", ss, "Crédito fiscal por contribuciones a la Seguridad Social"),
            line({ role: "VAT_TECH_BALANCE" }, "H", iva.previousTechnicalBalance, "Saldo técnico a favor del período anterior"),
            line({ role: "VAT_FREE_BALANCE" }, "H", iva.previousFreeBalance, "Libre disponibilidad del período anterior"),
            line({ role: "VAT_RETENTIONS" }, "H", iva.withholdings, "Retenciones de IVA sufridas"),
            line({ role: "VAT_PERCEPTIONS" }, "H", sum([iva.perceptions, iva.customsPerceptions]), "Percepciones de IVA sufridas"),
            line({ role: "VAT_PAYABLE" }, "H", iva.balanceToPay, "Saldo de impuesto a pagar"),
        ]),
    };
    assertBalanced(entry);
    return entry;
}

/** DDJJ de IIBB (LiquidationResult.iibb + SIRTAC separado de las retenciones). */
export interface IibbPosition {
    tax: Decimalish;
    otherDebits: Decimalish;
    previousBalance: Decimalish;
    /** Retenciones incluyendo SIRTAC (como en la DDJJ). */
    withholdings: Decimalish;
    /** Parte SIRTAC de `withholdings`. */
    sirtac: Decimalish;
    perceptions: Decimalish;
    customsPerceptions: Decimalish;
    bankCollections: Decimalish;
    paymentsOnAccount: Decimalish;
    otherCredits: Decimalish;
    balanceDgr: Decimalish;
    balanceTaxpayer: Decimalish;
}

/**
 * Cierre de la DDJJ de IIBB:
 *  Debe  Impuesto sobre los Ingresos Brutos (impuesto determinado + otros débitos)
 *  Haber saldo a favor anterior · retenciones · SIRTAC · percepciones · SIRCREB · pagos a cuenta · otros créditos
 *  Haber IIBB a pagar  /  Debe IIBB saldo a favor
 */
export function buildIibbEntry(i: IibbPosition, month: number, year: number): DraftEntry {
    const p = pp(month, year);
    const entry: DraftEntry = {
        kind: "IIBB_POSITION",
        date: lastDayOfMonth(year, month),
        description: `DDJJ de Ingresos Brutos ${p}`,
        lines: compact([
            line({ role: "IIBB_EXPENSE" }, "D", i.tax, "Impuesto determinado"),
            line({ role: "IIBB_EXPENSE" }, "D", i.otherDebits, "Otros débitos de la DDJJ"),
            line({ role: "IIBB_BALANCE" }, "D", i.balanceTaxpayer, "Saldo a favor del contribuyente"),
            line({ role: "IIBB_BALANCE" }, "H", i.previousBalance, "Saldo a favor del período anterior"),
            line({ role: "IIBB_RETENTIONS" }, "H", sub(i.withholdings, i.sirtac), "Retenciones sufridas"),
            line({ role: "IIBB_SIRTAC" }, "H", i.sirtac, "Recaudaciones SIRTAC"),
            line({ role: "IIBB_PERCEPTIONS" }, "H", sum([i.perceptions, i.customsPerceptions]), "Percepciones sufridas"),
            line({ role: "IIBB_SIRCREB" }, "H", i.bankCollections, "Recaudaciones bancarias SIRCREB"),
            line({ role: "IIBB_PAYMENTS" }, "H", i.paymentsOnAccount, "Pagos a cuenta"),
            line({ role: "IIBB_BALANCE" }, "H", i.otherCredits, "Otros créditos de la DDJJ"),
            line({ role: "IIBB_PAYABLE" }, "H", i.balanceDgr, "Saldo a favor de la DGR"),
        ]),
    };
    assertBalanced(entry);
    return entry;
}

export const PAYMENT_TAXES = ["VAT", "IIBB"] as const;
export type PaymentTax = (typeof PAYMENT_TAXES)[number];
export const PAYMENT_TAX_LABEL: Record<PaymentTax, string> = { VAT: "IVA", IIBB: "Ingresos Brutos" };

export interface TaxPayment {
    tax: PaymentTax;
    date: string;
    capital: Decimalish;
    interest: Decimalish;
    /** Impuesto a los débitos y créditos del movimiento de pago. */
    idcb: Decimalish;
    /** Porcentaje computable en Ganancias (idcbComputablePercent). */
    idcbPercent: number;
    paymentAccountId: string;
    reference: string | null;
}

/**
 * Pago con VEP:
 *  Debe  IVA / IIBB a pagar (capital)
 *  Debe  Intereses y recargos fiscales
 *  Debe  IDCB computable (porcentaje del certificado) · IDCB no computable (resto)
 *  Haber cuenta de pago (Caja, banco, billetera…)
 */
export function buildTaxPaymentEntry(t: TaxPayment): DraftEntry {
    const idcb = roundMoney(t.idcb);
    const computable = roundMoney(D(idcb).times(t.idcbPercent).div(100));
    const total = sum([t.capital, t.interest, idcb]);
    const ref = t.reference ? ` · ${t.reference}` : "";
    const entry: DraftEntry = {
        kind: "TAX_PAYMENT",
        date: t.date,
        description: `Pago de ${PAYMENT_TAX_LABEL[t.tax]}${ref}`,
        lines: compact([
            line({ role: t.tax === "VAT" ? "VAT_PAYABLE" : "IIBB_PAYABLE" }, "D", t.capital, "Impuesto"),
            line({ role: "TAX_INTEREST" }, "D", t.interest, "Intereses resarcitorios"),
            line({ role: "IDCB_COMPUTABLE" }, "D", computable, `Imp. débitos y créditos computable (${t.idcbPercent} %)`),
            line({ role: "IDCB_EXPENSE" }, "D", sub(idcb, computable), "Imp. débitos y créditos no computable"),
            line({ accountId: t.paymentAccountId }, "H", total, "Pago"),
        ]),
    };
    assertBalanced(entry);
    return entry;
}

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type TaxPaymentInput = Omit<TaxPayment, "idcbPercent">;
export type InputResult<T> = { ok: true; value: T } | { ok: false; field: string; error: string };

function amount(raw: unknown, field: string, required: boolean): InputResult<Prisma.Decimal> {
    if ((raw === undefined || raw === null || raw === "") && !required) return { ok: true, value: ZERO };
    // Acepta «56105.30», «56105,30» y «56.105,30» (miles con punto, decimales con coma).
    const t = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    const s = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
    if (!AMOUNT.test(s)) return { ok: false, field, error: "Importe inválido (hasta 2 decimales, sin signo)." };
    return { ok: true, value: D(s) };
}

/** Valida el cuerpo del formulario de pago (sin el porcentaje, que sale del perfil). */
export function buildTaxPaymentInput(raw: unknown): InputResult<TaxPaymentInput> {
    if (!raw || typeof raw !== "object") return { ok: false, field: "body", error: "Datos inválidos." };
    const r = raw as Record<string, unknown>;
    if (!PAYMENT_TAXES.includes(r.tax as PaymentTax)) return { ok: false, field: "tax", error: "Elegí el impuesto." };
    if (typeof r.date !== "string" || !DATE.test(r.date) || Number.isNaN(Date.parse(r.date))) return { ok: false, field: "date", error: "Fecha inválida." };
    const capital = amount(r.capital, "capital", true);
    if (!capital.ok) return capital;
    if (capital.value.isZero()) return { ok: false, field: "capital", error: "El impuesto pagado debe ser mayor que cero." };
    const interest = amount(r.interest, "interest", false);
    if (!interest.ok) return interest;
    const idcb = amount(r.idcb, "idcb", false);
    if (!idcb.ok) return idcb;
    if (typeof r.paymentAccountId !== "string" || r.paymentAccountId.length === 0 || r.paymentAccountId.length > 40) return { ok: false, field: "paymentAccountId", error: "Elegí la cuenta de pago." };
    const reference = typeof r.reference === "string" && r.reference.trim() !== "" ? r.reference.trim().slice(0, 60) : null;
    return { ok: true, value: { tax: r.tax as PaymentTax, date: r.date, capital: capital.value, interest: interest.value, idcb: idcb.value, paymentAccountId: r.paymentAccountId, reference } };
}
