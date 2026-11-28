/**
 * ¿La fila quedó para revisar sólo por una diferencia de redondeo de ARCA
 * (hasta $0,02) entre el total informado y la suma de sus componentes?
 * Sin dependencias de servidor: lo usa la vista previa del navegador.
 * El texto es el de build.ts («el total informado X no coincide con la suma
 * de sus componentes Y (diferencia Z)»).
 */
export const ROUNDING_MESSAGE_RE = /no coincide con la suma de sus componentes -?[\d.]+ \(diferencia -?0\.0[12]\)/;

export const hasRoundingDifference = (messages: readonly string[]) => messages.some((m) => ROUNDING_MESSAGE_RE.test(m));

/** Diferencia entre el IVA informado y el calculado de hasta $1 (corrección acceptReportedVat). */
export const REPORTED_VAT_MESSAGE_RE = /IVA informado ([\d.]+) y calculado ([\d.]+) difieren en más de 0,01/;
export const hasSmallReportedVatDifference = (messages: readonly string[]) => messages.some((m) => {
    const x = REPORTED_VAT_MESSAGE_RE.exec(m);
    return x !== null && Math.abs(Math.round(Number(x[1]) * 100) - Math.round(Number(x[2]) * 100)) <= 100;
});

/** Neto gravado al 0 % sin código de operación (corrección zeroRateOperationCode). */
export const ZERO_RATE_MESSAGE_RE = /neto gravado al 0 %|alícuota 0% sin código de operación/;
export const hasZeroRateWithoutCode = (messages: readonly string[]) => messages.some((m) => ZERO_RATE_MESSAGE_RE.test(m));
