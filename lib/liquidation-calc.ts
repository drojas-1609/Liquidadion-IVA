import "server-only";
import { Prisma } from "@prisma/client";
import { D, sum, sub, roundMoney } from "./decimal";
import {
  normalizeInvoiceRow,
  globalCoefficientOf,
  computeProratedCredit,
  MissingGlobalProrationCoefficientError,
  type InvoiceRowLike,
  type PeriodVatSettingsLike,
} from "./invoice-model";

/**
 * Cálculo autoritativo de la liquidación de un período.
 *
 * ÚNICA fuente de esta lógica: la consumen la exportación a Excel, el
 * dashboard de período y la pantalla de liquidación. Sin aritmética nativa
 * de JS en ningún paso. Sin redondeos intermedios: solo se redondea el
 * impuesto de IIBB, que es un importe calculado por la app.
 *
 * `vatRate` y `defaultIibbRate` son número de porcentaje (21, 10.5), no
 * coeficiente.
 *
 * Fase A: cada comprobante se lee con `normalizeInvoiceRow` (lib/invoice-model):
 *  - Débito fiscal   = Σ_ventas  signo × IVA liquidado (totalVatAmount)
 *  - Crédito directo = Σ_compras signo × directComputableVatCreditAmount
 *                      (líneas DIRECT_COMPUTABLE; DIRECT_NON_COMPUTABLE aporta 0)
 *  - Prorrateo       = HALF_UP(coeficiente global × Σ_compras signo × IVA de
 *                      las líneas GLOBAL_PRORATION, 2) — UNA vez, sobre el
 *                      total del PERÍODO. Sin coeficiente -> falla cerrada.
 *  - Crédito por compras = crédito directo + prorrateo
 *  - Ajustes al crédito fiscal por contribuciones a la Seguridad Social
 *    (importe COMPUTABLE que carga el estudio; la app no calcula porcentajes):
 *      · Ley 27.467 art. 91: antes que los demás créditos y hasta el débito
 *        fiscal del período (el excedente no se computa: no genera saldo a favor).
 *      · Ley 27.541 art. 21 y Anexo I: se suma al crédito, sin tope.
 *  - Total del crédito fiscal = compras + art. 91 aplicado + Anexo I
 *  - Saldo técnico (F.2051, Determinación del impuesto) =
 *      débito − crédito − saldo técnico a favor del período anterior.
 *    Positivo: a favor de ARCA. Negativo: a favor del contribuyente; se
 *    traslada y NO se compensa con retenciones ni percepciones.
 *  - Saldo de libre disponibilidad del período anterior (neto de usos, lo
 *    carga el estudio), retenciones, percepciones y percepciones aduaneras
 *    sólo cancelan el saldo técnico a favor de ARCA; el excedente es saldo a
 *    favor de libre disponibilidad. Retención o percepción sale del tipo
 *    (catálogo cerrado lib/tax-types) y la aduanera de `nature`.
 *  - Base IIBB       = Σ_ventas  signo × grossIncomeTaxBaseAmount
 *  El signo sale exclusivamente del código oficial del comprobante. Las filas
 *  heredadas sin representar se liquidan EXACTAMENTE como antes. Las
 *  percepciones informadas en el comprobante NO entran (fase F); las de
 *  TaxRecord siguen entrando como hasta ahora.
 */

/** Fila de Invoice para el cálculo (columnas nuevas opcionales). */
export type InvoiceForCalc = InvoiceRowLike;

export interface TaxRecordForCalc {
  type: string;
  amount: Prisma.Decimal;
  /** Detalle F.2051: CUSTOMS_PERCEPTION separa la percepción aduanera. */
  nature?: string | null;
}

export type VatCreditAdjustmentRegimeLike = "LEY_27541_ANEXO_I" | "LEY_27467_ART_91";

export interface VatCreditAdjustmentForCalc {
  regime: VatCreditAdjustmentRegimeLike | string;
  computableAmount: Prisma.Decimal;
}

export interface PeriodForCalc {
  invoices: InvoiceForCalc[];
  taxRecords: TaxRecordForCalc[];
  client: { defaultIibbRate: Prisma.Decimal | null };
  /** Configuración de IVA del período; ausente = NONE, sin coeficiente, sin saldo anterior. */
  vatSettings?: (PeriodVatSettingsLike & { previousTechnicalBalance?: Prisma.Decimal | null; previousFreeBalance?: Prisma.Decimal | null }) | null;
  /** Ajustes al crédito fiscal por contribuciones a la Seguridad Social; ausente = ninguno. */
  vatCreditAdjustments?: VatCreditAdjustmentForCalc[] | null;
}

export interface LiquidationTotals {
  net: Prisma.Decimal;
  vat: Prisma.Decimal;
  total: Prisma.Decimal;
}

export interface LiquidationResult {
  sales: LiquidationTotals;
  purchases: LiquidationTotals;
  iva: {
    debit: Prisma.Decimal;
    /** Total del crédito fiscal del período = creditPurchases + ajustes aplicados. */
    credit: Prisma.Decimal;
    /** Crédito por compras = creditDirect + creditProrated. */
    creditPurchases: Prisma.Decimal;
    creditDirect: Prisma.Decimal;
    creditProrated: Prisma.Decimal;
    /** IVA sujeto a prorrateo global (con signo). */
    globalProrationVat: Prisma.Decimal;
    /** Ley 27.541 Anexo I: computable cargado (sin tope). */
    creditSocialSecurityAnnexI: Prisma.Decimal;
    /** Ley 27.467 art. 91: computable cargado. */
    creditSocialSecurityArt91Declared: Prisma.Decimal;
    /** Ley 27.467 art. 91 aplicado: min(cargado, débito). */
    creditSocialSecurityArt91: Prisma.Decimal;
    /** Saldo técnico a favor del contribuyente del período anterior (lo carga el estudio). */
    previousTechnicalBalance: Prisma.Decimal;
    /** Saldo técnico con signo: débito − crédito − saldo técnico anterior. */
    balance: Prisma.Decimal;
    /** Saldo técnico a favor de ARCA (≥ 0). */
    technicalBalanceArca: Prisma.Decimal;
    /** Saldo técnico a favor del contribuyente (≥ 0): se traslada al período siguiente. */
    technicalBalanceInFavor: Prisma.Decimal;
    /** Retenciones + percepciones + percepciones aduaneras de IVA. */
    retentions: Prisma.Decimal;
    /** Retenciones de IVA sufridas. */
    withholdings: Prisma.Decimal;
    /** Percepciones de IVA sufridas (excepto aduaneras). */
    perceptions: Prisma.Decimal;
    /** Percepciones aduaneras de IVA. */
    customsPerceptions: Prisma.Decimal;
    /** Saldo de libre disponibilidad del período anterior, neto de usos. */
    previousFreeBalance: Prisma.Decimal;
    /**
     * Saldo de impuesto: technicalBalanceArca − libre disponibilidad anterior −
     * retenciones y percepciones. Positivo: a pagar a ARCA. Negativo: saldo a
     * favor de libre disponibilidad (nunca incluye el saldo técnico).
     */
    payable: Prisma.Decimal;
    /** Saldo de impuesto a favor de ARCA (≥ 0). */
    balanceToPay: Prisma.Decimal;
    /** Saldo a favor de libre disponibilidad del contribuyente (≥ 0). */
    freeBalanceInFavor: Prisma.Decimal;
  };
  iibb: {
    rate: Prisma.Decimal;
    base: Prisma.Decimal;
    tax: Prisma.Decimal;
    retentions: Prisma.Decimal;
    payable: Prisma.Decimal;
  };
}

function isIvaRetention(type: string): boolean {
  return type.includes("IVA");
}

function isIibbRetention(type: string): boolean {
  return type.includes("IIBB") || type === "SIRCREB" || type === "SIRTAC";
}

export function computeLiquidation(period: PeriodForCalc): LiquidationResult {
  const rows = period.invoices.map(normalizeInvoiceRow);
  const sales = rows.filter((i) => i.category === "SALES");
  const purchases = rows.filter((i) => i.category === "PURCHASES");

  const salesTotals: LiquidationTotals = {
    net: sum(sales.map((s) => s.signedNet)),
    vat: sum(sales.map((s) => s.signedVat)),
    total: sum(sales.map((s) => s.signedTotal)),
  };
  const purchasesTotals: LiquidationTotals = {
    net: sum(purchases.map((p) => p.signedNet)),
    vat: sum(purchases.map((p) => p.signedVat)),
    total: sum(purchases.map((p) => p.signedTotal)),
  };

  const ivaDebit = sum(sales.map((s) => s.vatDebit));
  const ivaCreditDirect = sum(purchases.map((p) => p.vatDirectCredit));
  // Falla cerrada: una compra modelada sin sus líneas no permite saber si hay
  // IVA sujeto a prorrateo global.
  if (purchases.some((p) => p.globalProrationVat === null)) {
    throw new Error("Liquidación: faltan las líneas de IVA de las compras (vatLines no cargadas).");
  }
  const globalProrationVat = sum(purchases.map((p) => p.globalProrationVat as Prisma.Decimal));
  let ivaCreditProrated = D("0");
  if (purchases.some((p) => p.hasGlobalProrationLines === true)) {
    const coefficient = globalCoefficientOf(period.vatSettings);
    if (coefficient === null) throw new MissingGlobalProrationCoefficientError();
    ivaCreditProrated = computeProratedCredit(coefficient, globalProrationVat);
  }
  const ivaCreditPurchases = ivaCreditDirect.plus(ivaCreditProrated);

  // Ajustes por contribuciones a la Seguridad Social (importe computable cargado).
  const adjustments = period.vatCreditAdjustments ?? [];
  for (const a of adjustments) {
    if (a.regime !== "LEY_27541_ANEXO_I" && a.regime !== "LEY_27467_ART_91") {
      throw new Error("Liquidación: régimen de ajuste al crédito fiscal desconocido.");
    }
    if (a.computableAmount.isNegative()) throw new Error("Liquidación: ajuste al crédito fiscal negativo.");
  }
  const annexI = sum(adjustments.filter((a) => a.regime === "LEY_27541_ANEXO_I").map((a) => a.computableAmount));
  const art91Declared = sum(adjustments.filter((a) => a.regime === "LEY_27467_ART_91").map((a) => a.computableAmount));
  // Art. 91: antes que los demás créditos y hasta el débito; sin débito, nada.
  const debitCap = ivaDebit.isNegative() ? D("0") : ivaDebit;
  const art91 = art91Declared.greaterThan(debitCap) ? debitCap : art91Declared;

  const ivaCredit = sum([ivaCreditPurchases, art91, annexI]);
  const previous = period.vatSettings?.previousTechnicalBalance ?? D("0");
  if (previous.isNegative()) throw new Error("Liquidación: saldo técnico anterior negativo.");
  const ivaBalance = sub(sub(ivaDebit, ivaCredit), previous);
  const zero = D("0");
  const technicalBalanceArca = ivaBalance.isPositive() && !ivaBalance.isZero() ? ivaBalance : zero;
  const technicalBalanceInFavor = ivaBalance.isNegative() ? ivaBalance.negated() : zero;
  const ivaRecords = period.taxRecords.filter((t) => isIvaRetention(t.type));
  const customsPerceptions = sum(ivaRecords.filter((t) => t.nature === "CUSTOMS_PERCEPTION").map((t) => t.amount));
  const perceptions = sum(ivaRecords.filter((t) => t.nature !== "CUSTOMS_PERCEPTION" && t.type.includes("PERCEPCION")).map((t) => t.amount));
  const ivaRetentions = sum(ivaRecords.map((t) => t.amount));
  const withholdings = sub(sub(ivaRetentions, perceptions), customsPerceptions);
  const previousFree = period.vatSettings?.previousFreeBalance ?? D("0");
  if (previousFree.isNegative()) throw new Error("Liquidación: saldo de libre disponibilidad anterior negativo.");
  // Libre disponibilidad anterior, retenciones y percepciones sólo cancelan el saldo a favor de ARCA.
  const ivaPayable = sub(sub(technicalBalanceArca, previousFree), ivaRetentions);
  const balanceToPay = ivaPayable.isPositive() && !ivaPayable.isZero() ? ivaPayable : zero;
  const freeBalanceInFavor = ivaPayable.isNegative() ? ivaPayable.negated() : zero;

  const iibbRate = period.client.defaultIibbRate ?? D("3");
  const iibbBase = sum(sales.map((s) => s.grossIncomeTaxBase));
  const iibbTax = roundMoney(D(iibbBase).times(iibbRate).div(100));
  const iibbRetentions = sum(
    period.taxRecords.filter((t) => isIibbRetention(t.type)).map((t) => t.amount),
  );
  const iibbPayable = sub(iibbTax, iibbRetentions);

  return {
    sales: salesTotals,
    purchases: purchasesTotals,
    iva: {
      debit: ivaDebit,
      credit: ivaCredit,
      creditPurchases: ivaCreditPurchases,
      creditDirect: ivaCreditDirect,
      creditProrated: ivaCreditProrated,
      globalProrationVat,
      creditSocialSecurityAnnexI: annexI,
      creditSocialSecurityArt91Declared: art91Declared,
      creditSocialSecurityArt91: art91,
      previousTechnicalBalance: previous,
      balance: ivaBalance,
      technicalBalanceArca,
      technicalBalanceInFavor,
      retentions: ivaRetentions,
      withholdings,
      perceptions,
      customsPerceptions,
      previousFreeBalance: previousFree,
      payable: ivaPayable,
      balanceToPay,
      freeBalanceInFavor,
    },
    iibb: {
      rate: iibbRate,
      base: iibbBase,
      tax: iibbTax,
      retentions: iibbRetentions,
      payable: iibbPayable,
    },
  };
}
