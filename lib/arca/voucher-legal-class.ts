import { VOUCHER_TYPES, SOURCE_LID_TABLAS, SOURCE_RG_1575, SOURCE_RG_4627, SOURCE_RG_5762, type OfficialSource } from "./catalogs";

/**
 * Clase jurídica y leyenda DERIVADAS de un comprobante por código y fecha.
 *
 * No se almacenan: se calculan siempre desde `voucherCode` y `voucherDate`.
 * El caso que motiva este módulo es 051–053: la Tabla 3 los denomina "M" en
 * todo momento, pero
 *   - 20/10/2003 – 10/11/2019: clase M con la leyenda de $1.000 (RG 1575 art. 11 original);
 *   - 11/11/2019 – 30/11/2025: clase M con "OPERACIÓN SUJETA A RETENCIÓN" (RG 1575 art. 10 según RG 4627);
 *   - desde 01/12/2025: clase A con "OPERACIÓN SUJETA A RETENCIÓN" (RG 5762 arts. 11, 28, 31 y 32).
 * Antes del 20/10/2003 (inicio de aplicación de RG 1575, art. 35) no se deriva clase.
 *
 * Fechas como texto ISO `AAAA-MM-DD` (día calendario, sin zona horaria).
 * Lógica pura, sin `server-only`.
 */

export const RG_1575_START = "2003-10-20";
export const RG_4627_START = "2019-11-11";
export const RG_5762_START = "2025-12-01";

export const LEGEND_M_1000 = "LA OPERACION IGUAL O MAYOR A UN MIL PESOS ($ 1.000.-) ESTA SUJETA A RETENCION";
export const LEGEND_OPERACION_SUJETA_A_RETENCION = "OPERACIÓN SUJETA A RETENCIÓN";

export type LegalClass = "A" | "B" | "C" | "E" | "M" | "T";

export interface DerivedVoucherClass {
    /** Denominación técnica de la Tabla 3 (Tablas del Sistema). */
    technicalLabel: string;
    /** Clase jurídica a la fecha, o null si la norma no la define para esa fecha. */
    legalClass: LegalClass | null;
    /** Leyenda obligatoria derivada (sólo 051–053), o null. */
    mandatoryLegend: string | null;
    sources: readonly OfficialSource[];
}

const M_CODES = new Set([51, 52, 53]);

export function derivedVoucherClass(code: number, dateIso: string): DerivedVoucherClass {
    const vt = VOUCHER_TYPES.find((v) => v.code === code);
    if (!vt) throw new Error(`código de comprobante fuera del catálogo: ${code}`);

    if (!M_CODES.has(code)) {
        return { technicalLabel: vt.label, legalClass: vt.letter as LegalClass, mandatoryLegend: null, sources: [vt.source] };
    }
    if (dateIso < RG_1575_START) {
        return { technicalLabel: vt.label, legalClass: null, mandatoryLegend: null, sources: [SOURCE_LID_TABLAS, SOURCE_RG_1575] };
    }
    if (dateIso < RG_4627_START) {
        return { technicalLabel: vt.label, legalClass: "M", mandatoryLegend: LEGEND_M_1000, sources: [SOURCE_LID_TABLAS, SOURCE_RG_1575] };
    }
    if (dateIso < RG_5762_START) {
        return {
            technicalLabel: vt.label,
            legalClass: "M",
            mandatoryLegend: LEGEND_OPERACION_SUJETA_A_RETENCION,
            sources: [SOURCE_LID_TABLAS, SOURCE_RG_1575, SOURCE_RG_4627],
        };
    }
    return {
        technicalLabel: vt.label,
        legalClass: "A",
        mandatoryLegend: LEGEND_OPERACION_SUJETA_A_RETENCION,
        sources: [SOURCE_LID_TABLAS, SOURCE_RG_5762],
    };
}
