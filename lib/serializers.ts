import "server-only";
import { Prisma } from "@prisma/client";
import type { LiquidationResult } from "./liquidation-calc";

/**
 * Serialización explícita de los modelos con campos Decimal.
 *
 * El contrato de API expone TODOS los decimales como `string`. No se depende
 * de `Prisma.Decimal.toJSON()` implícito: cada campo se convierte acá.
 * - Importes: `.toFixed(2)` (escala fija 2).
 * - Alícuotas: `.toString()` (forma canónica, hasta 6 decimales).
 */

const money = (d: Prisma.Decimal): string => d.toFixed(2);
const rate = (d: Prisma.Decimal): string => d.toString();
const iso = (d: Date): string => d.toISOString();

export interface ClientDTO {
  id: string;
  name: string;
  cuit: string;
  condition: string;
  address: string | null;
  defaultIibbRate: string;
  createdAt: string;
  updatedAt: string;
}

export function serializeClient(c: {
  id: string;
  name: string;
  cuit: string;
  condition: string;
  address: string | null;
  defaultIibbRate: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
}): ClientDTO {
  return {
    id: c.id,
    name: c.name,
    cuit: c.cuit,
    condition: c.condition,
    address: c.address,
    defaultIibbRate: rate(c.defaultIibbRate),
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

export interface PeriodDTO {
  id: string;
  clientId: string;
  month: number;
  year: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Period no tiene campos Decimal. Se serializa igual para NO exponer campos
 * internos (organizationId, createdById, updatedById): contrato mínimo.
 */
export function serializePeriod(p: {
  id: string;
  clientId: string;
  month: number;
  year: number;
  createdAt: Date;
  updatedAt: Date;
}): PeriodDTO {
  return {
    id: p.id,
    clientId: p.clientId,
    month: p.month,
    year: p.year,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

export interface InvoiceDTO {
  id: string;
  // Columnas heredadas (semántica anterior; nullable desde la Fase A).
  date: string | null;
  type: string | null;
  pointOfSale: number;
  number: number;
  entityName: string | null;
  entityCuit: string | null;
  netAmount: string;
  vatRate: string | null;
  vatAmount: string;
  totalAmount: string;
  category: string;
  periodId: string;
  // Modelo contable (Fase A). NULL en filas heredadas sin representar.
  voucherCode: number | null;
  /** `AAAA-MM-DD`, sin zona horaria. */
  voucherDate: string | null;
  currencyCode: string | null;
  exchangeRate: string | null;
  taxedNetAmount: string | null;
  totalVatAmount: string | null;
  directComputableVatCreditAmount: string | null;
  reportedComputableVatCreditAmount: string | null;
  netWithoutVatBreakdownAmount: string | null;
  grossIncomeTaxBaseAmount: string | null;
  voucherTotalAmount: string | null;
  turivaRefundAmount: string | null;
  lidSection: string | null;
}

type Dec = Prisma.Decimal;
const moneyOrNull = (d: Dec | null | undefined): string | null => (d == null ? null : money(d));

export function serializeInvoice(i: {
  id: string;
  date: Date | null;
  type: string | null;
  pointOfSale: number;
  number: number;
  entityName: string | null;
  entityCuit: string | null;
  netAmount: Dec;
  vatRate: Dec | null;
  vatAmount: Dec;
  totalAmount: Dec;
  category: string;
  periodId: string;
  voucherCode?: number | null;
  voucherDate?: Date | null;
  currencyCode?: string | null;
  exchangeRate?: Dec | null;
  taxedNetAmount?: Dec | null;
  totalVatAmount?: Dec | null;
  directComputableVatCreditAmount?: Dec | null;
  reportedComputableVatCreditAmount?: Dec | null;
  netWithoutVatBreakdownAmount?: Dec | null;
  grossIncomeTaxBaseAmount?: Dec | null;
  voucherTotalAmount?: Dec | null;
  turivaRefundAmount?: Dec | null;
  lidSection?: string | null;
}): InvoiceDTO {
  return {
    id: i.id,
    date: i.date ? iso(i.date) : null,
    type: i.type,
    pointOfSale: i.pointOfSale,
    number: i.number,
    entityName: i.entityName,
    entityCuit: i.entityCuit,
    netAmount: money(i.netAmount),
    vatRate: i.vatRate == null ? null : rate(i.vatRate),
    vatAmount: money(i.vatAmount),
    totalAmount: money(i.totalAmount),
    category: i.category,
    periodId: i.periodId,
    voucherCode: i.voucherCode ?? null,
    voucherDate: i.voucherDate ? iso(i.voucherDate).slice(0, 10) : null,
    currencyCode: i.currencyCode ?? null,
    exchangeRate: i.exchangeRate == null ? null : i.exchangeRate.toString(),
    taxedNetAmount: moneyOrNull(i.taxedNetAmount),
    totalVatAmount: moneyOrNull(i.totalVatAmount),
    directComputableVatCreditAmount: moneyOrNull(i.directComputableVatCreditAmount),
    reportedComputableVatCreditAmount: moneyOrNull(i.reportedComputableVatCreditAmount),
    netWithoutVatBreakdownAmount: moneyOrNull(i.netWithoutVatBreakdownAmount),
    grossIncomeTaxBaseAmount: moneyOrNull(i.grossIncomeTaxBaseAmount),
    voucherTotalAmount: moneyOrNull(i.voucherTotalAmount),
    turivaRefundAmount: moneyOrNull(i.turivaRefundAmount),
    lidSection: i.lidSection ?? null,
  };
}

export interface TaxRecordDTO {
  id: string;
  date: string;
  type: string;
  amount: string;
  description: string | null;
  periodId: string;
}

export function serializeTaxRecord(t: {
  id: string;
  date: Date;
  type: string;
  amount: Prisma.Decimal;
  description: string | null;
  periodId: string;
}): TaxRecordDTO {
  return {
    id: t.id,
    date: iso(t.date),
    type: t.type,
    amount: money(t.amount),
    description: t.description,
    periodId: t.periodId,
  };
}

export interface LiquidationDTO {
  sales: { net: string; vat: string; total: string };
  purchases: { net: string; vat: string; total: string };
  iva: {
    debit: string;
    /** Crédito fiscal computable total = directo + prorrateo global. */
    credit: string;
    creditDirect: string;
    creditProrated: string;
    /** IVA sujeto a prorrateo global (base del prorrateo). */
    globalProrationVat: string;
    balance: string;
    retentions: string;
    payable: string;
  };
  iibb: { rate: string; base: string; tax: string; retentions: string; payable: string };
}

/** Serializa el resultado (todo Prisma.Decimal) de computeLiquidation a strings. */
export function serializeLiquidation(r: LiquidationResult): LiquidationDTO {
  return {
    sales: { net: money(r.sales.net), vat: money(r.sales.vat), total: money(r.sales.total) },
    purchases: { net: money(r.purchases.net), vat: money(r.purchases.vat), total: money(r.purchases.total) },
    iva: {
      debit: money(r.iva.debit),
      credit: money(r.iva.credit),
      creditDirect: money(r.iva.creditDirect),
      creditProrated: money(r.iva.creditProrated),
      globalProrationVat: money(r.iva.globalProrationVat),
      balance: money(r.iva.balance),
      retentions: money(r.iva.retentions),
      payable: money(r.iva.payable),
    },
    iibb: {
      rate: rate(r.iibb.rate),
      base: money(r.iibb.base),
      tax: money(r.iibb.tax),
      retentions: money(r.iibb.retentions),
      payable: money(r.iibb.payable),
    },
  };
}
