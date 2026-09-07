import { Prisma } from "@prisma/client";

/**
 * Validadores de decimales para entradas EXTERNAS (bodies de API).
 *
 * Reglas:
 * - reciben siempre string; nunca pasan por `parseFloat`/`Number`;
 * - rechazan vacío, NaN, Infinity, notación exponencial y caracteres inválidos;
 * - controlan escala y precisión: el EXCESO se rechaza, nunca se trunca ni se
 *   redondea en silencio;
 * - importes: admiten signo negativo (notas de crédito), hasta 2 decimales;
 * - alícuotas: número de porcentaje (no coeficiente), >= 0, <= 100, hasta 6
 *   decimales.
 *
 * El redondeo a 2 decimales es responsabilidad del cálculo de la app
 * (`lib/decimal.ts`), no de la validación de entradas.
 */

export type DecimalParse =
  | { ok: true; value: Prisma.Decimal }
  | { ok: false; error: string };

// Solo dígitos, un punto decimal opcional y un signo menos opcional al inicio.
// Sin '+', sin 'e/E', sin espacios internos, sin separador de miles.
const MONEY_RE = /^-?\d+(\.\d+)?$/;
const RATE_RE = /^\d+(\.\d+)?$/; // alícuotas: sin signo (>= 0)

const MONEY_SCALE = 2;
const MONEY_INT_DIGITS = 16; // NUMERIC(18,2) => 18 - 2
const RATE_SCALE = 6;

function preCheck(raw: unknown): { ok: true; s: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "debe ser un string" };
  const s = raw.trim();
  if (s === "") return { ok: false, error: "no puede estar vacío" };
  if (/[eE]/.test(s)) return { ok: false, error: "no se admite notación exponencial" };
  if (/\s/.test(s)) return { ok: false, error: "no se admiten espacios" };
  return { ok: true, s };
}

function scaleOf(s: string): number {
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

function intDigitsOf(s: string): number {
  const body = s.replace(/^-/, "");
  const i = body.indexOf(".");
  const intPart = (i === -1 ? body : body.slice(0, i)).replace(/^0+(?=\d)/, "");
  return intPart.length;
}

/** Importe monetario para entradas externas. `NUMERIC(18,2)`, signo permitido. */
export function parseMoney(raw: unknown, opts: { allowNegative?: boolean } = {}): DecimalParse {
  const allowNegative = opts.allowNegative ?? true;
  const pre = preCheck(raw);
  if (!pre.ok) return pre;
  const s = pre.s;

  if (!MONEY_RE.test(s)) return { ok: false, error: "formato de importe inválido" };
  if (!allowNegative && s.startsWith("-")) return { ok: false, error: "no se admite un importe negativo" };

  if (scaleOf(s) > MONEY_SCALE) {
    return { ok: false, error: `demasiados decimales (máximo ${MONEY_SCALE}); no se redondea la entrada` };
  }
  if (intDigitsOf(s) > MONEY_INT_DIGITS) {
    return { ok: false, error: `importe fuera de rango (máximo ${MONEY_INT_DIGITS} dígitos enteros)` };
  }

  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(s);
  } catch {
    return { ok: false, error: "no es un número válido" };
  }
  if (!value.isFinite()) return { ok: false, error: "el valor no es finito" };
  return { ok: true, value };
}

/** Alícuota porcentual para entradas externas. `NUMERIC(9,6)`, 0 <= x <= 100. */
export function parseRate(raw: unknown): DecimalParse {
  const pre = preCheck(raw);
  if (!pre.ok) return pre;
  const s = pre.s;

  if (!RATE_RE.test(s)) return { ok: false, error: "formato de alícuota inválido (no se admite signo negativo)" };
  if (scaleOf(s) > RATE_SCALE) {
    return { ok: false, error: `demasiados decimales en la alícuota (máximo ${RATE_SCALE}); no se redondea la entrada` };
  }

  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(s);
  } catch {
    return { ok: false, error: "no es un número válido" };
  }
  if (!value.isFinite()) return { ok: false, error: "el valor no es finito" };
  if (value.lessThan(0)) return { ok: false, error: "la alícuota debe ser mayor o igual a 0" };
  if (value.greaterThan(100)) return { ok: false, error: "la alícuota debe ser menor o igual a 100" };
  return { ok: true, value };
}
