/**
 * ¿La fila quedó para revisar sólo por una diferencia de redondeo de ARCA
 * (hasta $0,02) entre el total informado y la suma de sus componentes?
 * Sin dependencias de servidor: lo usa la vista previa del navegador.
 * El texto es el de build.ts («el total informado X no coincide con la suma
 * de sus componentes Y (diferencia Z)»).
 */
export const ROUNDING_MESSAGE_RE = /no coincide con la suma de sus componentes -?[\d.]+ \(diferencia -?0\.0[12]\)/;

export const hasRoundingDifference = (messages: readonly string[]) => messages.some((m) => ROUNDING_MESSAGE_RE.test(m));
