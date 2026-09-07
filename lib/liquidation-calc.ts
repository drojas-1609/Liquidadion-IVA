import { Prisma } from "@prisma/client";
import { D, sum, sub, roundMoney } from "./decimal";

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
 */

export interface InvoiceForCalc {
  category: string;
  netAmount: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
}

export interface TaxRecordForCalc {
  type: string;
  amount: Prisma.Decimal;
}

export interface PeriodForCalc {
  invoices: InvoiceForCalc[];
  taxRecords: TaxRecordForCalc[];
  client: { defaultIibbRate: Prisma.Decimal | null };
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
    credit: Prisma.Decimal;
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
  const sales = period.invoices.filter((i) => i.category === "SALES");
  const purchases = period.invoices.filter((i) => i.category === "PURCHASES");

  const salesTotals: LiquidationTotals = {
    net: sum(sales.map((s) => s.netAmount)),
    vat: sum(sales.map((s) => s.vatAmount)),
    total: sum(sales.map((s) => s.totalAmount)),
  };
  const purchasesTotals: LiquidationTotals = {
    net: sum(purchases.map((p) => p.netAmount)),
    vat: sum(purchases.map((p) => p.vatAmount)),
    total: sum(purchases.map((p) => p.totalAmount)),
  };

  const ivaDebit = salesTotals.vat;
  const ivaCredit = purchasesTotals.vat;
  const ivaBalance = sub(ivaDebit, ivaCredit);
  const ivaRetentions = sum(
    period.taxRecords.filter((t) => isIvaRetention(t.type)).map((t) => t.amount),
  );
  const ivaPayable = sub(ivaBalance, ivaRetentions);

  const iibbRate = period.client.defaultIibbRate ?? D("3");
  const iibbBase = salesTotals.net;
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
