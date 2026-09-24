/**
 * Normalización y validación de CUIT/CUIL.
 *
 * Formato canónico persistido: `NN-NNNNNNNN-N`. Se aceptan entradas con o sin
 * separadores (espacios, puntos, guiones), pero NUNCA se descartan otros
 * caracteres: una entrada con letras o símbolos se rechaza, no se "limpia".
 *
 * Normalizar ANTES de persistir hace que `@@unique([organizationId, cuit])`
 * trate `20-00000000-1`, `20000000001` y `20 00000000 1` como el mismo CUIT.
 *
 * Sin dependencias ni `server-only`: es lógica pura, apta para cliente y servidor.
 */

export type CuitResult = { ok: true; value: string } | { ok: false; error: string };

const ALLOWED_INPUT_RE = /^[\d .-]+$/;
const SEPARATORS_RE = /[ .-]/g;
const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/**
 * Dígito verificador oficial (módulo 11) para los 10 primeros dígitos.
 * Devuelve `null` cuando el resultado es 10: esa combinación no es un CUIT válido.
 */
export function cuitCheckDigit(first10: string): number | null {
  const sum = WEIGHTS.reduce((acc, w, i) => acc + w * Number(first10[i]), 0);
  const r = 11 - (sum % 11);
  if (r === 11) return 0;
  if (r === 10) return null;
  return r;
}

export function normalizeCuit(input: unknown): CuitResult {
  if (typeof input !== "string") return { ok: false, error: "CUIT requerido" };
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "CUIT requerido" };
  if (!ALLOWED_INPUT_RE.test(trimmed)) {
    return { ok: false, error: "CUIT inválido: solo se admiten dígitos, espacios, puntos y guiones" };
  }

  const digits = trimmed.replace(SEPARATORS_RE, "");
  if (!/^\d{11}$/.test(digits)) return { ok: false, error: "CUIT inválido: debe tener 11 dígitos" };

  const expected = cuitCheckDigit(digits.slice(0, 10));
  if (expected === null || expected !== Number(digits[10])) {
    return { ok: false, error: "CUIT inválido: dígito verificador incorrecto" };
  }

  return { ok: true, value: `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits[10]}` };
}
