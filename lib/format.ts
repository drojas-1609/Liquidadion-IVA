/**
 * Formateo de importes SOLO para pantalla.
 *
 * Acepta un string decimal (contrato de la app) y lo formatea con separadores
 * es-AR y 2 decimales. La conversión a `Number` acá es EXCLUSIVAMENTE para
 * `toLocaleString`: nunca se usa el resultado para recalcular ni persistir.
 */
export function formatMoney(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Formatea una alícuota (número de porcentaje) para pantalla, sin ceros de más. */
export function formatRate(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("es-AR", { maximumFractionDigits: 6 });
}

/**
 * Fecha contable `AAAA-MM-DD` -> `DD/MM/AAAA`, sin pasar por `Date` (no hay
 * zona horaria que pueda correr el día). Entrada inválida o null -> "—".
 */
export function formatIsoDate(value: string | null): string {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}
