import { Prisma } from "@prisma/client";

/**
 * Utilidad compartida de aritmética decimal exacta.
 *
 * Regla dura (Tarea 2): NO se muta la configuración global de decimal.js.
 * - Nada de `Prisma.Decimal.set(...)`.
 * - Nada de tocar `Prisma.Decimal.rounding` / `.precision` a nivel módulo.
 * - Cada redondeo a importe monetario pasa el modo `ROUND_HALF_UP` de forma
 *   explícita vía `toDecimalPlaces(2, ROUND_HALF_UP)`.
 *
 * Esta es la única fuente de redondeo/sumatoria de importes del servidor.
 */

export type Decimalish = Prisma.Decimal | string | number;

/** Modo de redondeo monetario. Convención técnica actual y configurable. */
export const MONEY_ROUNDING = Prisma.Decimal.ROUND_HALF_UP;

/** Escala de importes monetarios. */
export const MONEY_DP = 2;

export const ZERO = new Prisma.Decimal(0);

/** Construye un Decimal sin redondear. */
export function D(value: Decimalish): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/**
 * Redondea a 2 decimales con ROUND_HALF_UP, explícito, sin config global.
 * Se usa SOLO para resultados calculados por la aplicación (IVA, totales de
 * período, etc.), nunca para "arreglar" una entrada externa.
 */
export function roundMoney(value: Decimalish): Prisma.Decimal {
  return D(value).toDecimalPlaces(MONEY_DP, MONEY_ROUNDING);
}

/**
 * Suma exacta sin aritmética nativa de JS en ningún paso.
 * No redondea resultados intermedios.
 */
export function sum(values: Iterable<Decimalish>): Prisma.Decimal {
  let acc = new Prisma.Decimal(0);
  for (const v of values) acc = acc.plus(D(v));
  return acc;
}

/** Resta exacta a - b. */
export function sub(a: Decimalish, b: Decimalish): Prisma.Decimal {
  return D(a).minus(D(b));
}

/**
 * IVA autoritativo: ROUND_HALF_UP(netAmount * vatRate / 100, 2).
 * `vatRate` es número de porcentaje (21, 10.5), no coeficiente.
 * Sin redondeos intermedios: se redondea una sola vez, al final.
 */
export function computeVatAmount(netAmount: Decimalish, vatRate: Decimalish): Prisma.Decimal {
  return roundMoney(D(netAmount).times(D(vatRate)).div(100));
}

/**
 * Total autoritativo: netAmount + vatAmount (ambos ya en escala 2).
 * La suma de dos valores de 2 decimales es exacta; no se vuelve a redondear.
 */
export function computeTotalAmount(netAmount: Decimalish, vatAmount: Decimalish): Prisma.Decimal {
  return D(netAmount).plus(D(vatAmount));
}
