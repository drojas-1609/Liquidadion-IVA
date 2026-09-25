/**
 * Representación canónica de un período fiscal mensual.
 *
 * La fuente de verdad son `year` y `month` (enteros, en columnas separadas):
 * un período NO es una fecha y no depende de zona horaria. Las formas de texto
 * se derivan siempre de acá:
 *   - clave canónica:  `YYYY-MM`  (orden lexicográfico = cronológico)
 *   - etiqueta visible: `MM/AAAA`
 *
 * El rango de años admitido se calcula en UTC y es la ÚNICA regla, compartida
 * por la API (`buildPeriodInput`) y el formulario de alta.
 *
 * Sin dependencias ni `server-only`: lógica pura, apta para cliente y servidor.
 */

export const PERIOD_MIN_YEAR = 2000;

export const MONTH_NAMES = [
    "Enero",
    "Febrero",
    "Marzo",
    "Abril",
    "Mayo",
    "Junio",
    "Julio",
    "Agosto",
    "Septiembre",
    "Octubre",
    "Noviembre",
    "Diciembre",
] as const;

/** Rango de años admitido: 2000 .. (año UTC actual + 1), ambos inclusive. */
export function periodYearRange(now: Date = new Date()): { min: number; max: number } {
    return { min: PERIOD_MIN_YEAR, max: now.getUTCFullYear() + 1 };
}

/** Años admitidos en orden DESCENDENTE (para el selector del formulario). */
export function periodYearOptions(now: Date = new Date()): number[] {
    const { min, max } = periodYearRange(now);
    return Array.from({ length: max - min + 1 }, (_, i) => max - i);
}

export function isValidPeriodMonth(month: number): boolean {
    return Number.isInteger(month) && month >= 1 && month <= 12;
}

export function isValidPeriodYear(year: number, now: Date = new Date()): boolean {
    const { min, max } = periodYearRange(now);
    return Number.isInteger(year) && year >= min && year <= max;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Clave canónica `YYYY-MM`. */
export function formatPeriodKey(p: { year: number; month: number }): string {
    return `${p.year}-${pad2(p.month)}`;
}

/** Etiqueta visible `MM/AAAA`. */
export function formatPeriodLabel(p: { year: number; month: number }): string {
    return `${pad2(p.month)}/${p.year}`;
}
