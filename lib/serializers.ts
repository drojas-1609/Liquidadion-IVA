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
  date: string;
  type: string;
  pointOfSale: number;
  number: number;
  entityName: string;
  entityCuit: string;
  netAmount: string;
  vatRate: string;
  vatAmount: string;
  totalAmount: string;
  category: string;
  periodId: string;
}

export function serializeInvoice(i: {
  id: string;
  date: Date;
  type: string;
  pointOfSale: number;
  number: number;
  entityName: string;
  entityCuit: string;
  netAmount: Prisma.Decimal;
  vatRate: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  category: string;
  periodId: string;
}): InvoiceDTO {
  return {
    id: i.id,
    date: iso(i.date),
    type: i.type,
    pointOfSale: i.pointOfSale,
    number: i.number,
    entityName: i.entityName,
    entityCuit: i.entityCuit,
    netAmount: money(i.netAmount),
    vatRate: rate(i.vatRate),
    vatAmount: money(i.vatAmount),
    totalAmount: money(i.totalAmount),
    category: i.category,
    periodId: i.periodId,
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
  iva: { debit: string; credit: string; balance: string; retentions: string; payable: string };
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
