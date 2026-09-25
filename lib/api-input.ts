import "server-only";
import { Prisma } from "@prisma/client";
import { D, moneyInRange, MONEY_MAX } from "./decimal";
import { parseMoney, parseRate } from "./validation/decimal";
import { normalizeCuit } from "./cuit";
import { isValidPeriodMonth, isValidPeriodYear, periodYearRange } from "./period";
import { modelFromLegacyInput, legacyColumnsFor, type InvoiceCategory, type InvoiceModelData } from "./invoice-model";

/**
 * Construcción y validación de los `data` de creación para las rutas de API.
 *
 * Toda la validación de decimales pasa por `lib/validation/decimal` (strings,
 * sin `parseFloat`).
 *
 * Tarea 3B: cuando `ok === false` el `status` es 422 (UNPROCESSABLE_ENTITY):
 * el JSON es válido pero los datos son semánticamente inválidos. El 400
 * (BAD_REQUEST) queda reservado para JSON ausente/malformado y lo produce
 * `parseJsonBody` (lib/auth/authz), ANTES de llegar acá.
 *
 * `invoices` recalcula SIEMPRE `vatAmount` y `totalAmount` en el servidor con
 * `lib/decimal`; ignora cualquier valor de esos campos enviado por el cliente.
 */

export type InputResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 422; field: string; error: string };

function fail(field: string, error: string): { ok: false; status: 422; field: string; error: string } {
  return { ok: false, status: 422, field, error };
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function parseIntStrict(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

// ── Period ─────────────────────────────────────────────────────────────────

export interface PeriodCreateData {
  clientId: string;
  month: number;
  year: number;
}

/**
 * Valida la forma de un alta de período. NO comprueba que `clientId` exista ni
 * pertenezca a la organización: de eso se ocupa `requireClientAccess` (404).
 */
export function buildPeriodInput(body: unknown, now: Date = new Date()): InputResult<PeriodCreateData> {
  if (typeof body !== "object" || body === null) return fail("body", "cuerpo inválido");
  const b = body as Record<string, unknown>;

  if (!nonEmptyString(b.clientId)) return fail("clientId", "clientId requerido");

  const month = parseIntStrict(b.month);
  if (month === null || !isValidPeriodMonth(month)) return fail("month", "mes inválido (1 a 12)");

  // Misma regla (UTC) que el formulario de alta: lib/period.ts.
  const year = parseIntStrict(b.year);
  if (year === null || !isValidPeriodYear(year, now)) {
    const { min, max } = periodYearRange(now);
    return fail("year", `año inválido (${min} a ${max})`);
  }

  return { ok: true, data: { clientId: b.clientId, month, year } };
}

// ── Invoice ────────────────────────────────────────────────────────────────

export interface InvoiceCreateData {
  // Columnas heredadas (semántica anterior, con signo), derivadas del modelo.
  date: Date;
  type: string;
  pointOfSale: number;
  number: number;
  entityName: string;
  entityCuit: string;
  netAmount: Prisma.Decimal;
  vatRate: Prisma.Decimal | null;
  vatAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  category: InvoiceCategory;
  periodId: string;
  /** Modelo contable (Fase A): importes positivos, signo por código oficial. */
  model: InvoiceModelData;
}

/**
 * Contrato ACTUAL de /api/invoices (una alícuota). Fase A: además de validar,
 * construye el modelo contable (`modelFromLegacyInput`) y deriva de él las
 * columnas heredadas, para que ambas representaciones liquiden igual.
 */
export function buildInvoiceInput(body: unknown): InputResult<InvoiceCreateData> {
  if (typeof body !== "object" || body === null) return fail("body", "cuerpo inválido");
  const b = body as Record<string, unknown>;

  if (!nonEmptyString(b.date)) return fail("date", "fecha requerida");
  const date = new Date(b.date);
  if (Number.isNaN(date.getTime())) return fail("date", "fecha inválida");

  if (!nonEmptyString(b.type)) return fail("type", "tipo de comprobante requerido");
  if (!nonEmptyString(b.entityName)) return fail("entityName", "razón social requerida");
  const entityCuit = normalizeCuit(b.entityCuit);
  if (!entityCuit.ok) return fail("entityCuit", entityCuit.error);
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
  const built = modelFromLegacyInput({
    category,
    type: b.type,
    date,
    pointOfSale,
    number,
    entityName: b.entityName,
    entityCuit: entityCuit.value,
    netAmount: net.value,
    vatRate: rate.value,
  });
  if (!built.ok) return fail(built.field, built.error);
  const model = built.model;

  // Un neto válido puede derivar en un IVA o total fuera de NUMERIC(18,2).
  // Se corta acá con 422; nunca llega como 500 desde PostgreSQL.
  const limit = `debe estar entre -${MONEY_MAX.toFixed(2)} y ${MONEY_MAX.toFixed(2)}`;
  if (!moneyInRange(model.totalVatAmount)) {
    return fail("vatAmount", `el IVA calculado (${model.totalVatAmount.toFixed(2)}) queda fuera de rango: ${limit}`);
  }
  if (!moneyInRange(model.voucherTotalAmount)) {
    return fail("totalAmount", `el total calculado (${model.voucherTotalAmount.toFixed(2)}) queda fuera de rango: ${limit}`);
  }

  const legacy = legacyColumnsFor(model);
  return {
    ok: true,
    data: {
      date: legacy.date,
      type: legacy.type,
      pointOfSale,
      number,
      entityName: legacy.entityName,
      entityCuit: legacy.entityCuit,
      netAmount: legacy.netAmount,
      vatRate: legacy.vatRate,
      vatAmount: legacy.vatAmount,
      totalAmount: legacy.totalAmount,
      category,
      periodId: b.periodId,
      model,
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
  // Canónico NN-NNNNNNNN-N antes de persistir: la unicidad por organización
  // compara siempre el mismo formato.
  const cuit = normalizeCuit(b.cuit);
  if (!cuit.ok) return fail("cuit", cuit.error);
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

  return { ok: true, data: { name: b.name, cuit: cuit.value, condition: b.condition, address, defaultIibbRate } };
}

// ── Client (edición parcial) ────────────────────────────────────────────────

/** Campos editables de un Client. Cualquier otra clave del body se IGNORA. */
export const CLIENT_UPDATABLE_FIELDS = ["name", "cuit", "condition", "address", "defaultIibbRate"] as const;
export type ClientUpdatableField = (typeof CLIENT_UPDATABLE_FIELDS)[number];

export type ClientUpdateData = Partial<ClientCreateData>;

/**
 * Valida un PATCH de Client. Sólo se consideran las claves presentes de
 * `CLIENT_UPDATABLE_FIELDS`; `organizationId`, `id`, autoría y timestamps del
 * body se ignoran. El CUIT pasa por `normalizeCuit` (mismo formato canónico que
 * el alta). Sin ningún campo editable -> 422.
 */
export function buildClientUpdateInput(body: unknown): InputResult<ClientUpdateData> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("body", "cuerpo inválido");
  }
  const b = body as Record<string, unknown>;
  const data: ClientUpdateData = {};

  if (b.name !== undefined) {
    if (!nonEmptyString(b.name)) return fail("name", "nombre requerido");
    data.name = b.name.trim();
  }
  if (b.cuit !== undefined) {
    const cuit = normalizeCuit(b.cuit);
    if (!cuit.ok) return fail("cuit", cuit.error);
    data.cuit = cuit.value;
  }
  if (b.condition !== undefined) {
    if (!nonEmptyString(b.condition)) return fail("condition", "condición fiscal requerida");
    data.condition = b.condition.trim();
  }
  if (b.address !== undefined) {
    if (b.address === null || b.address === "") data.address = null;
    else if (typeof b.address === "string") data.address = b.address.trim() === "" ? null : b.address.trim();
    else return fail("address", "dirección inválida");
  }
  if (b.defaultIibbRate !== undefined) {
    const parsed = parseRate(b.defaultIibbRate);
    if (!parsed.ok) return fail("defaultIibbRate", parsed.error);
    data.defaultIibbRate = parsed.value;
  }

  if (Object.keys(data).length === 0) return fail("body", "no hay campos para actualizar");
  return { ok: true, data };
}
