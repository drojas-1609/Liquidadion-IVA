import { Prisma } from "@prisma/client";
import { D, computeVatAmount, computeTotalAmount } from "./decimal";
import { parseMoney, parseRate } from "./validation/decimal";

/**
 * Construcción y validación de los `data` de creación para las rutas de API.
 *
 * Toda la validación de decimales pasa por `lib/validation/decimal` (strings,
 * sin `parseFloat`). Las rutas devuelven 400 con `{ field, error }` cuando
 * `ok === false`.
 *
 * `invoices` recalcula SIEMPRE `vatAmount` y `totalAmount` en el servidor con
 * `lib/decimal`; ignora cualquier valor de esos campos enviado por el cliente.
 */

export type InputResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400; field: string; error: string };

function fail(field: string, error: string): { ok: false; status: 400; field: string; error: string } {
  return { ok: false, status: 400, field, error };
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function parseIntStrict(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

// ── Invoice ────────────────────────────────────────────────────────────────

export interface InvoiceCreateData {
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
}

export function buildInvoiceInput(body: unknown): InputResult<InvoiceCreateData> {
  if (typeof body !== "object" || body === null) return fail("body", "cuerpo inválido");
  const b = body as Record<string, unknown>;

  if (!nonEmptyString(b.date)) return fail("date", "fecha requerida");
  const date = new Date(b.date);
  if (Number.isNaN(date.getTime())) return fail("date", "fecha inválida");

  if (!nonEmptyString(b.type)) return fail("type", "tipo de comprobante requerido");
  if (!nonEmptyString(b.entityName)) return fail("entityName", "razón social requerida");
  if (!nonEmptyString(b.entityCuit)) return fail("entityCuit", "CUIT requerido");
  if (!nonEmptyString(b.periodId)) return fail("periodId", "periodId requerido");

  const category = b.category;
  if (category !== "SALES" && category !== "PURCHASES") {
    return fail("category", "category debe ser SALES o PURCHASES");
  }

  const pointOfSale = parseIntStrict(b.pointOfSale);
  if (pointOfSale === null || pointOfSale < 0) return fail("pointOfSale", "punto de venta inválido");
  const number = parseIntStrict(b.number);
  if (number === null || number < 0) return fail("number", "número de comprobante inválido");

  const net = parseMoney(b.netAmount, { allowNegative: true });
  if (!net.ok) return fail("netAmount", net.error);
  const rate = parseRate(b.vatRate);
  if (!rate.ok) return fail("vatRate", rate.error);

  // Autoritativo: se ignoran b.vatAmount / b.totalAmount del cliente.
  const vatAmount = computeVatAmount(net.value, rate.value);
  const totalAmount = computeTotalAmount(net.value, vatAmount);

  return {
    ok: true,
    data: {
      date,
      type: b.type,
      pointOfSale,
      number,
      entityName: b.entityName,
      entityCuit: b.entityCuit,
      netAmount: net.value,
      vatRate: rate.value,
      vatAmount,
      totalAmount,
      category,
      periodId: b.periodId,
    },
  };
}

// ── TaxRecord ──────────────────────────────────────────────────────────────

export interface TaxCreateData {
  date: Date;
  type: string;
  amount: Prisma.Decimal;
  description: string | null;
  periodId: string;
}

export function buildTaxInput(body: unknown): InputResult<TaxCreateData> {
  if (typeof body !== "object" || body === null) return fail("body", "cuerpo inválido");
  const b = body as Record<string, unknown>;

  if (!nonEmptyString(b.date)) return fail("date", "fecha requerida");
  const date = new Date(b.date);
  if (Number.isNaN(date.getTime())) return fail("date", "fecha inválida");

  if (!nonEmptyString(b.type)) return fail("type", "tipo requerido");
  if (!nonEmptyString(b.periodId)) return fail("periodId", "periodId requerido");

  const amount = parseMoney(b.amount, { allowNegative: true });
  if (!amount.ok) return fail("amount", amount.error);

  const description =
    b.description === undefined || b.description === null || b.description === ""
      ? null
      : typeof b.description === "string"
        ? b.description
        : null;

  return {
    ok: true,
    data: { date, type: b.type, amount: amount.value, description, periodId: b.periodId },
  };
}

// ── Client ────────────────────────────────────────────────────────────────

export interface ClientCreateData {
  name: string;
  cuit: string;
  condition: string;
  address: string | null;
  defaultIibbRate: Prisma.Decimal;
}

export function buildClientInput(body: unknown): InputResult<ClientCreateData> {
  if (typeof body !== "object" || body === null) return fail("body", "cuerpo inválido");
  const b = body as Record<string, unknown>;

  if (!nonEmptyString(b.name)) return fail("name", "nombre requerido");
  if (!nonEmptyString(b.cuit)) return fail("cuit", "CUIT requerido");
  if (!nonEmptyString(b.condition)) return fail("condition", "condición fiscal requerida");

  const address =
    b.address === undefined || b.address === null || b.address === ""
      ? null
      : typeof b.address === "string"
        ? b.address
        : null;

  let defaultIibbRate: Prisma.Decimal;
  if (b.defaultIibbRate === undefined || b.defaultIibbRate === null || b.defaultIibbRate === "") {
    defaultIibbRate = D("3");
  } else {
    const parsed = parseRate(b.defaultIibbRate);
    if (!parsed.ok) return fail("defaultIibbRate", parsed.error);
    defaultIibbRate = parsed.value;
  }

  return { ok: true, data: { name: b.name, cuit: b.cuit, condition: b.condition, address, defaultIibbRate } };
}
