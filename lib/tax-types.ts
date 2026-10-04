/**
 * Catálogo CERRADO de tipos de retención/percepción (`TaxRecord.type`).
 *
 * Única fuente de los valores aceptados por la API. Los valores almacenados son
 * exactamente los que la app guardó siempre; no se migran ni se normalizan.
 * Sin `server-only`: también lo usarán los formularios.
 *
 * `tax` documenta el impuesto al que imputa cada tipo y coincide con la
 * clasificación vigente de lib/liquidation-calc (que NO consume este catálogo:
 * "contiene IVA" -> IVA; "contiene IIBB", SIRCREB o SIRTAC -> IIBB).
 *
 * Un registro histórico puede tener un `type` fuera del catálogo: se describe
 * como desconocido conservando su valor tal cual (`describeTaxRecordType`).
 */

export type TaxRecordTax = "IVA" | "IIBB";
export type TaxRecordNature = "RETENCION" | "PERCEPCION" | "RECAUDACION";

export interface TaxRecordTypeEntry {
  readonly value: string;
  readonly label: string;
  readonly tax: TaxRecordTax;
  readonly nature: TaxRecordNature;
}

export const TAX_RECORD_TYPES = Object.freeze([
  Object.freeze({ value: "RETENCION IVA", label: "Retención IVA", tax: "IVA", nature: "RETENCION" }),
  Object.freeze({ value: "PERCEPCION IVA", label: "Percepción IVA", tax: "IVA", nature: "PERCEPCION" }),
  Object.freeze({ value: "RETENCION IIBB", label: "Retención IIBB", tax: "IIBB", nature: "RETENCION" }),
  Object.freeze({ value: "PERCEPCION IIBB", label: "Percepción IIBB", tax: "IIBB", nature: "PERCEPCION" }),
  Object.freeze({ value: "SIRCREB", label: "SIRCREB (recaudación bancaria IIBB)", tax: "IIBB", nature: "RECAUDACION" }),
  Object.freeze({ value: "SIRTAC", label: "SIRTAC (recaudación tarjetas IIBB)", tax: "IIBB", nature: "RECAUDACION" }),
] as const) satisfies readonly TaxRecordTypeEntry[];

/** Valor almacenado de un tipo del catálogo. */
export type TaxRecordType = (typeof TAX_RECORD_TYPES)[number]["value"];

const BY_VALUE: ReadonlyMap<string, (typeof TAX_RECORD_TYPES)[number]> = new Map(
  TAX_RECORD_TYPES.map((t) => [t.value, t]),
);

/** `true` sólo si `value` es EXACTAMENTE uno de los valores del catálogo (sin trim ni mayúsculas). */
export function isTaxRecordType(value: unknown): value is TaxRecordType {
  return typeof value === "string" && BY_VALUE.has(value);
}

/** Rótulo visible de un tipo del catálogo. */
export function taxRecordTypeLabel(type: TaxRecordType): string {
  const entry = BY_VALUE.get(type);
  if (!entry) throw new Error(`tipo de retención/percepción fuera del catálogo: ${JSON.stringify(type)}`);
  return entry.label;
}

export type TaxRecordTypeDescription =
  | ({ known: true } & (typeof TAX_RECORD_TYPES)[number])
  | { known: false; value: string };

/**
 * Describe un `type` almacenado. Fuera del catálogo -> `{ known: false, value }`
 * con el valor ORIGINAL, sin reemplazarlo, recortarlo ni ocultarlo.
 */
export function describeTaxRecordType(value: string): TaxRecordTypeDescription {
  const entry = BY_VALUE.get(value);
  return entry ? { known: true, ...entry } : { known: false, value };
}
