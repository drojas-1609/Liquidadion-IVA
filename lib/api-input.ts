import "server-only";
import { Prisma } from "@prisma/client";
import { D, moneyInRange, MONEY_MAX } from "./decimal";
import { parseMoney, parseRate } from "./validation/decimal";
import { normalizeCuit } from "./cuit";
import { CLIENT_CONDITION_ERROR, isClientCondition } from "./client-condition";
import { isValidPeriodMonth, isValidPeriodYear, periodYearRange } from "./period";
import type { InvoiceCategory, InvoiceModelData } from "./invoice-model";
import { VAT_CONDITIONS, VOUCHER_TYPES, type VoucherVariant } from "./arca/catalogs";
import { isTaxRecordType, type TaxRecordType } from "./tax-types";

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

/**
 * Fecha calendario estricta `YYYY-MM-DD` -> medianoche UTC del mismo día; si
 * no, null. Rechaza horas, zonas, offsets, barras, espacios (sin trim) y
 * formatos alternativos. Sin fecha mínima.
 */
export function parseIsoDateOnly(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  // Ida y vuelta UTC: descarta días inexistentes (2026-02-30 -> 2026-03-02).
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? d : null;
}

/** `true` si el día UTC de `date` cae en el mes (1-12) y año del período. Pura: no consulta la base. */
export function isDateInPeriod(date: Date, period: { month: number; year: number }): boolean {
  return date.getUTCFullYear() === period.year && date.getUTCMonth() + 1 === period.month;
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

/**
 * Un neto válido puede derivar en un IVA o total fuera de NUMERIC(18,2). Se
 * corta con 422; nunca llega como 500 desde PostgreSQL.
 */
export function modelRangeError(model: InvoiceModelData): { field: string; error: string } | null {
  const limit = `debe estar entre -${MONEY_MAX.toFixed(2)} y ${MONEY_MAX.toFixed(2)}`;
  if (!moneyInRange(model.totalVatAmount)) {
    return { field: "vatAmount", error: `el IVA calculado (${model.totalVatAmount.toFixed(2)}) queda fuera de rango: ${limit}` };
  }
  if (!moneyInRange(model.voucherTotalAmount)) {
    return { field: "totalAmount", error: `el total calculado (${model.voucherTotalAmount.toFixed(2)}) queda fuera de rango: ${limit}` };
  }
  return null;
}

// ── Invoice: contrato v2 (matriz normativa) ────────────────────────────────

export const INVOICE_CONTRACT_VERSION = 2;
export const INVOICE_CONTRACT_OUTDATED_MESSAGE =
  "contrato de comprobantes obsoleto: la solicitud debe usar contractVersion 2";

const VOUCHER_VARIANT_CODES: readonly VoucherVariant[] = ["NONE", "PAGO_EN_CBU_INFORMADA"];

export interface InvoiceV2Data {
  category: InvoiceCategory;
  periodId: string;
  /** Medianoche UTC del día informado. */
  date: Date;
  /** El mismo día como `AAAA-MM-DD` (matriz y clase jurídica). */
  dateIso: string;
  voucherCode: number;
  voucherVariant: VoucherVariant | null;
  pointOfSale: number;
  number: number;
  counterparty: {
    name: string;
    docType: number;
    /** Tal como llegó (sin espacios en los extremos); lo normaliza lib/arca/document-rules. */
    docNumber: string;
    vatConditionCode: number;
  };
  turivaRelationCode: string | null;
  /** Neto informado; una nota de crédito puede venir con signo negativo. */
  netAmount: Prisma.Decimal;
  vatRate: Prisma.Decimal;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Máximo de `Invoice.pointOfSale` / `Invoice.number` (Int de Prisma = integer de PostgreSQL, 32 bits). */
export const VOUCHER_INT_MAX = 2147483647;

/** Entero JSON en 1..VOUCHER_INT_MAX (nunca llega a la base un valor que la columna rechace). */
const positiveSafeInteger = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= VOUCHER_INT_MAX ? v : null;

/**
 * Contrato v2 de POST /api/invoices: SÓLO la forma. La matriz normativa, el
 * documento y el modelo se resuelven con datos de la base (lib/manual-invoice).
 * Sin `contractVersion` exactamente igual al número 2 -> 422 contractVersion
 * (incluido el contrato anterior completo, p. ej. `type: "FC T"`).
 * Se ignoran clientId, organizationId, condición del cliente, lidSection,
 * source, vatAmount, totalAmount, clase jurídica, leyendas y toda otra clave.
 */
export function buildInvoiceInputV2(body: unknown): InputResult<InvoiceV2Data> {
  if (!isPlainObject(body)) return fail("body", "cuerpo inválido");
  const b = body;

  if (b.contractVersion !== INVOICE_CONTRACT_VERSION) return fail("contractVersion", INVOICE_CONTRACT_OUTDATED_MESSAGE);

  const category = b.category;
  if (category !== "SALES" && category !== "PURCHASES") {
    return fail("category", "category debe ser SALES o PURCHASES");
  }
  if (!nonEmptyString(b.periodId)) return fail("periodId", "periodId requerido");

  if (!nonEmptyString(b.date)) return fail("date", "fecha requerida");
  const date = parseIsoDateOnly(b.date);
  if (date === null) return fail("date", "fecha inválida: debe ser AAAA-MM-DD y existir en el calendario");

  if (typeof b.voucherCode !== "number" || !Number.isInteger(b.voucherCode)) {
    return fail("voucherCode", "tipo de comprobante requerido (código oficial numérico)");
  }
  const voucherCode = b.voucherCode;
  if (!VOUCHER_TYPES.some((v) => v.code === voucherCode)) {
    return fail("voucherCode", "tipo de comprobante fuera del catálogo oficial");
  }

  let voucherVariant: VoucherVariant | null = null;
  if (b.voucherVariant !== undefined && b.voucherVariant !== null) {
    if (!(VOUCHER_VARIANT_CODES as readonly unknown[]).includes(b.voucherVariant)) {
      return fail("voucherVariant", "variante inválida (NONE o PAGO_EN_CBU_INFORMADA)");
    }
    voucherVariant = b.voucherVariant as VoucherVariant;
  }

  // Entero JSON positivo dentro del rango de la columna: se rechazan 0,
  // negativos, decimales, valores mayores a VOUCHER_INT_MAX y texto (incluido
  // "1" o "1e3"). Mismo criterio que el formulario (lib/invoice-form-client).
  const pointOfSale = positiveSafeInteger(b.pointOfSale);
  if (pointOfSale === null) return fail("pointOfSale", `punto de venta inválido: debe ser un entero entre 1 y ${VOUCHER_INT_MAX}`);
  const number = positiveSafeInteger(b.number);
  if (number === null) return fail("number", `número de comprobante inválido: debe ser un entero entre 1 y ${VOUCHER_INT_MAX}`);

  if (!isPlainObject(b.counterparty)) return fail("counterparty", "datos de la contraparte requeridos");
  const cp = b.counterparty;
  if (!nonEmptyString(cp.name)) return fail("counterpartyName", "razón social de la contraparte requerida");
  if (typeof cp.docType !== "number" || !Number.isInteger(cp.docType)) {
    return fail("counterpartyDocType", "tipo de documento requerido (código numérico)");
  }
  if (!nonEmptyString(cp.docNumber)) return fail("counterpartyDocNumber", "número de documento requerido");
  const vatConditionCode = cp.vatConditionCode;
  if (typeof vatConditionCode !== "number" || !VAT_CONDITIONS.some((c) => c.code === vatConditionCode)) {
    return fail("counterpartyVatConditionCode", "condición fiscal de la contraparte inválida (tabla oficial de tipos de responsables)");
  }

  let turivaRelationCode: string | null = null;
  if (b.turivaRelationCode !== undefined && b.turivaRelationCode !== null) {
    if (typeof b.turivaRelationCode !== "string") return fail("turivaRelationCode", "relación TurIVA inválida (0001 a 0006)");
    turivaRelationCode = b.turivaRelationCode;
  }

  const net = parseMoney(b.netAmount, { allowNegative: true });
  if (!net.ok) return fail("netAmount", net.error);
  const rate = parseRate(b.vatRate);
  if (!rate.ok) return fail("vatRate", rate.error);

  return {
    ok: true,
    data: {
      category,
      periodId: b.periodId,
      date,
      dateIso: b.date,
      voucherCode,
      voucherVariant,
      pointOfSale,
      number,
      counterparty: {
        name: cp.name.trim(),
        docType: cp.docType,
        docNumber: cp.docNumber.trim(),
        vatConditionCode,
      },
      turivaRelationCode,
      netAmount: net.value,
      vatRate: rate.value,
    },
  };
}

// ── Invoice: edición y baja (concurrencia optimista) ────────────────────────

export const EXPECTED_UPDATED_AT_ERROR =
  "expectedUpdatedAt inválido: debe ser la fecha ISO exacta del comprobante (AAAA-MM-DDTHH:mm:ss.sssZ)";

/**
 * `updatedAt` que vio el usuario: ISO estricto con milisegundos y `Z`, que
 * además debe existir y volver al MISMO texto con `toISOString()` (así la
 * comparación contra la fila bloqueada es exacta, en milisegundos).
 */
export function parseExpectedUpdatedAt(v: unknown): InputResult<Date> {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) {
    return fail("expectedUpdatedAt", EXPECTED_UPDATED_AT_ERROR);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== v) return fail("expectedUpdatedAt", EXPECTED_UPDATED_AT_ERROR);
  return { ok: true, data: d };
}

export interface InvoiceUpdateData extends InvoiceV2Data {
  expectedUpdatedAt: Date;
}

/**
 * PATCH /api/invoices/[id]: el contrato v2 COMPLETO (mismas reglas y mensajes
 * que el alta) más `expectedUpdatedAt`. Cualquier otra clave se ignora.
 */
export function buildInvoiceUpdateInput(body: unknown): InputResult<InvoiceUpdateData> {
  const v2 = buildInvoiceInputV2(body);
  if (!v2.ok) return v2;
  const expected = parseExpectedUpdatedAt((body as Record<string, unknown>).expectedUpdatedAt);
  if (!expected.ok) return expected;
  return { ok: true, data: { ...v2.data, expectedUpdatedAt: expected.data } };
}

// ── TaxRecord ──────────────────────────────────────────────────────────────

/** Máximo de caracteres (puntos de código) de `TaxRecord.description`, tras el trim. */
export const TAX_DESCRIPTION_MAX = 200;

export const TAX_PERIOD_IMMUTABLE_MESSAGE =
  "No se puede cambiar el período de una retención/percepción: eliminala y cargala en el período correcto.";

/** Campos de negocio de un TaxRecord, comunes al alta y a la edición. */
export interface TaxFieldsData {
  /** Medianoche UTC del día informado (`AAAA-MM-DD`). */
  date: Date;
  type: TaxRecordType;
  /** Estrictamente mayor que cero, hasta 2 decimales, dentro de NUMERIC(18,2). */
  amount: Prisma.Decimal;
  description: string | null;
}

export interface TaxCreateData extends TaxFieldsData {
  periodId: string;
}

/** PATCH /api/taxes/[id]: reemplazo completo de los campos + token de concurrencia. */
export interface TaxUpdateData extends TaxFieldsData {
  expectedUpdatedAt: Date;
}

/**
 * Reglas comunes de alta y edición. La pertenencia de la fecha al mes/año del
 * período NO se controla acá: requiere el Period leído bajo el bloqueo.
 */
function parseTaxFields(b: Record<string, unknown>): InputResult<TaxFieldsData> {
  if (!nonEmptyString(b.date)) return fail("date", "fecha requerida");
  const date = parseIsoDateOnly(b.date);
  if (date === null) return fail("date", "fecha inválida: debe ser AAAA-MM-DD y existir en el calendario");

  if (!nonEmptyString(b.type)) return fail("type", "tipo requerido");
  if (!isTaxRecordType(b.type)) return fail("type", "tipo fuera del catálogo de retenciones/percepciones");

  const amount = parseMoney(b.amount, { allowNegative: false });
  if (!amount.ok) return fail("amount", amount.error);
  if (!amount.value.greaterThan(0)) return fail("amount", "el importe debe ser mayor que cero");

  let description: string | null;
  if (b.description === undefined || b.description === null) description = null;
  else if (typeof b.description === "string") {
    const trimmed = b.description.trim();
    if (Array.from(trimmed).length > TAX_DESCRIPTION_MAX) {
      return fail("description", `descripción demasiado larga (máximo ${TAX_DESCRIPTION_MAX} caracteres)`);
    }
    description = trimmed === "" ? null : trimmed;
  } else return fail("description", "descripción inválida: debe ser texto");

  return { ok: true, data: { date, type: b.type, amount: amount.value, description } };
}

/**
 * POST /api/taxes. Se ignoran organizationId, clientId, autoría y toda otra
 * clave del body.
 */
export function buildTaxInput(body: unknown): InputResult<TaxCreateData> {
  if (!isPlainObject(body)) return fail("body", "cuerpo inválido");
  const b = body;

  if (!nonEmptyString(b.date)) return fail("date", "fecha requerida");
  if (!nonEmptyString(b.type)) return fail("type", "tipo requerido");
  if (!nonEmptyString(b.periodId)) return fail("periodId", "periodId requerido");

  const fields = parseTaxFields(b);
  if (!fields.ok) return fields;
  return { ok: true, data: { ...fields.data, periodId: b.periodId } };
}

/**
 * PATCH /api/taxes/[id]: mismas reglas que el alta más `expectedUpdatedAt`.
 * `periodId` es opcional; si viene, debe ser exactamente `expectedPeriodId`
 * (el período no se cambia). Se ignoran organizationId, clientId, autoría y
 * toda otra clave del body.
 */
export function buildTaxUpdateInput(body: unknown, expectedPeriodId: string): InputResult<TaxUpdateData> {
  if (!isPlainObject(body)) return fail("body", "cuerpo inválido");
  const b = body;

  const fields = parseTaxFields(b);
  if (!fields.ok) return fields;

  if (b.periodId !== undefined && b.periodId !== expectedPeriodId) {
    return fail("periodId", TAX_PERIOD_IMMUTABLE_MESSAGE);
  }

  const expected = parseExpectedUpdatedAt(b.expectedUpdatedAt);
  if (!expected.ok) return expected;

  return { ok: true, data: { ...fields.data, expectedUpdatedAt: expected.data } };
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
  const condition = b.condition.trim();
  if (!isClientCondition(condition)) return fail("condition", CLIENT_CONDITION_ERROR);

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

  return { ok: true, data: { name: b.name, cuit: cuit.value, condition, address, defaultIibbRate } };
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
    const condition = b.condition.trim();
    if (!isClientCondition(condition)) return fail("condition", CLIENT_CONDITION_ERROR);
    data.condition = condition;
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

// ── PeriodVatSettings: inclusión en el Régimen TurIVA ────────────────────────

export interface TurivaSettingData {
  turivaIncluded: boolean;
}

// ── Period: cierre y reapertura (concurrencia optimista) ───────────────────

export const PERIOD_EXPECTED_UPDATED_AT_ERROR =
  "expectedUpdatedAt inválido: debe ser la fecha ISO exacta del período (AAAA-MM-DDTHH:mm:ss.sssZ)";

export interface PeriodTransitionData {
  /** `Period.updatedAt` que vio la pantalla: versión del ESTADO del período. */
  expectedUpdatedAt: Date;
}

/**
 * POST /api/periods/[id]/close y /reopen: `{ "expectedUpdatedAt": "<ISO>" }`,
 * obligatorio, con la misma regla estricta que la edición de comprobantes.
 * Otras claves se ignoran (el destino lo define la ruta, nunca el cuerpo).
 */
export function buildPeriodTransitionInput(body: unknown): InputResult<PeriodTransitionData> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("body", "cuerpo inválido");
  const expected = parseExpectedUpdatedAt((body as Record<string, unknown>).expectedUpdatedAt);
  if (!expected.ok) return fail("expectedUpdatedAt", PERIOD_EXPECTED_UPDATED_AT_ERROR);
  return { ok: true, data: { expectedUpdatedAt: expected.data } };
}

/**
 * `{ "turivaIncluded": true | false }`. Sólo se acepta un booleano JSON: los
 * strings ("true"), números, null o la ausencia de la clave son 422. Otras
 * claves se ignoran y no influyen en la operación.
 */
export function buildTurivaSettingInput(body: unknown): InputResult<TurivaSettingData> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("body", "cuerpo inválido");
  const b = body as Record<string, unknown>;
  if (typeof b.turivaIncluded !== "boolean") return fail("turivaIncluded", "turivaIncluded debe ser true o false");
  return { ok: true, data: { turivaIncluded: b.turivaIncluded } };
}
