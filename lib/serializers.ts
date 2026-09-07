import { Prisma } from "@prisma/client";

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
