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
 *  - Crédito fiscal  = crédito directo + prorrateo
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
}

export interface PeriodForCalc {
  invoices: InvoiceForCalc[];
  taxRecords: TaxRecordForCalc[];
  client: { defaultIibbRate: Prisma.Decimal | null };
  /** Configuración de IVA del período; ausente = NONE, sin coeficiente. */
  vatSettings?: PeriodVatSettingsLike | null;
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
    /** Crédito fiscal computable total = creditDirect + creditProrated. */
    credit: Prisma.Decimal;
    creditDirect: Prisma.Decimal;
    creditProrated: Prisma.Decimal;
    /** IVA sujeto a prorrateo global (con signo). */
    globalProrationVat: Prisma.Decimal;
    balance: Prisma.Decimal;
    retentions: Prisma.Decimal;
    payable: Prisma.Decimal;
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
  const ivaCredit = ivaCreditDirect.plus(ivaCreditProrated);
  const ivaBalance = sub(ivaDebit, ivaCredit);
  const ivaRetentions = sum(
    period.taxRecords.filter((t) => isIvaRetention(t.type)).map((t) => t.amount),
  );
  const ivaPayable = sub(ivaBalance, ivaRetentions);

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
      creditDirect: ivaCreditDirect,
      creditProrated: ivaCreditProrated,
      globalProrationVat,
      balance: ivaBalance,
      retentions: ivaRetentions,
      payable: ivaPayable,
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
