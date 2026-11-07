import { VOUCHER_TYPES } from "./catalogs";

/**
 * Documento 99 «SIN IDENTIFICAR / VENTA GLOBAL DIARIA» en VENTAS a
 * consumidores finales. Reglas oficiales verificadas el 06/11/2026:
 *
 *  - RG 1415, Anexo II, Apartado A, Título II, inciso d) (consumidor final): el
 *    comprador se identifica (DNI, CUIL o CDI; CUIT si lo pide) cuando el
 *    importe de la operación es IGUAL O SUPERIOR a $ 10.000.000. Texto de la
 *    RG 5700/2025, art. 1° (vigencia 29/05/2025) y de la RG 5866/2026, art. 1°
 *    inc. f) (vigencia 01/07/2026), que mantiene el monto.
 *    https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-5700-2025-413219/texto
 *    https://www.argentina.gob.ar/normativa/nacional/norma-427092/texto
 *  - Libro IVA Digital, Especificaciones (rev. 30/07/2025), Ventas, campos 6 a 8:
 *    código 99 = «Sin identificar/Venta Global Diaria»; el número de documento
 *    «podrá ser cero» con código 99; consumidor final que no requiere
 *    identificarse -> leyenda «CONSUMIDOR FINAL»; registración global diaria ->
 *    leyenda «VENTA GLOBAL DIARIA». Campos 4 y 5: en la registración agrupada
 *    por totales diarios se consignan el primer y el último número del rango.
 *    (El monto de $ 20.932 que cita esa especificación está desactualizado: rige
 *    el de la RG 1415 vigente.)
 *    https://www.afip.gob.ar/iva/documentos/Libro-IVA-Digital-Especificaciones.pdf
 *  - Libro IVA Digital, «Especificaciones y situaciones especiales a considerar
 *    para la registración electrónica de las operaciones», II b) a d): la
 *    registración por monto global diario se admite para comprobantes clase
 *    «B» o «C» emitidos a consumidores finales por importes por debajo del
 *    umbral de identificación, consignando el primero y el último número
 *    emitidos en el día; con el IVA discriminado, la registración es individual.
 *    https://www.afip.gob.ar/iva/documentos/libro-iva-digital-modalidades-especiales-de-registracion.pdf
 *
 * Decisiones (sin fuente que habilite más):
 *  - Fechas anteriores al 29/05/2025: el umbral histórico no se verificó ->
 *    no se admite el 99 (queda la identificación del comprador).
 *  - Venta global diaria: sólo FACTURAS B o C (no notas de crédito ni de
 *    débito: la fuente habla de comprobantes emitidos por las operaciones del
 *    día y no prevé agrupar devoluciones). Que CADA comprobante del rango esté
 *    por debajo del umbral no se puede verificar con el total del día: exige la
 *    confirmación expresa del usuario (validación parcial).
 *  - Nunca se convierte una venta a consumidor final en global: el modo lo elige
 *    el usuario en cada carga.
 */

export const UNIDENTIFIED_DOC_TYPE = 99;
export const LEGEND_UNIDENTIFIED = "CONSUMIDOR FINAL";
export const LEGEND_GLOBAL_DAILY = "VENTA GLOBAL DIARIA";
export const IDENTIFICATION_THRESHOLD = "10000000.00";
/** Primer día con el umbral verificado (RG 5700/2025, art. 4°). */
export const THRESHOLD_VERIFIED_FROM = "2025-05-29";

export type UnidentifiedSaleMode = "INDIVIDUAL" | "GLOBAL_DAILY";

export interface UnidentifiedSaleInput {
    category: "SALES" | "PURCHASES";
    dateIso: string;
    voucherCode: number;
    number: number;
    numberTo: number | null;
    mode: UnidentifiedSaleMode | null;
    counterpartyName: string;
    docNumber: string;
    /** Total del comprobante (individual) o del día (global), en centavos. */
    totalCents: bigint;
    /** Venta global: el usuario confirma que cada comprobante del rango es menor al umbral. */
    belowThresholdConfirmed: boolean;
}

export type UnidentifiedSaleCheck =
    | { ok: true; numberTo: number; name: string; partialValidation: boolean }
    | { ok: false; field: string; error: string };

const fail = (field: string, error: string): UnidentifiedSaleCheck => ({ ok: false, field, error });
const thresholdCents = BigInt(IDENTIFICATION_THRESHOLD.replace(".", ""));

/** Reglas del documento 99 (sólo se llama con docType 99). */
export function checkUnidentifiedSale(i: UnidentifiedSaleInput): UnidentifiedSaleCheck {
    if (i.category !== "SALES") return fail("counterpartyDocType", "el documento 99 (sin identificar) sólo corresponde a ventas a consumidores finales");
    const vt = VOUCHER_TYPES.find((v) => v.code === i.voucherCode);
    if (!vt || (vt.letter !== "B" && vt.letter !== "C")) return fail("voucherCode", "el documento 99 sólo corresponde a comprobantes clase B o C a consumidores finales");
    if (i.dateIso < THRESHOLD_VERIFIED_FROM) {
        return fail("counterpartyDocType", `antes del ${THRESHOLD_VERIFIED_FROM.split("-").reverse().join("/")} el umbral de identificación no está verificado: identificá al comprador`);
    }
    if (!/^0+$/.test(i.docNumber.trim())) return fail("counterpartyDocNumber", "con el documento 99 el número de documento es 0");
    if (i.mode === null) return fail("unidentifiedSaleMode", "indicá si es una venta individual sin identificar o la venta global diaria");

    if (i.mode === "INDIVIDUAL") {
        if (i.numberTo !== null && i.numberTo !== i.number) return fail("numberTo", "una venta individual no lleva rango de comprobantes: para el rango del día elegí «venta global diaria»");
        if (i.totalCents >= thresholdCents) return fail("netAmount", "desde $ 10.000.000 el comprador debe identificarse (RG 1415, Anexo II, A, II d)");
        if (i.counterpartyName.trim().toUpperCase() !== LEGEND_UNIDENTIFIED) return fail("counterpartyName", `con el documento 99 la denominación es «${LEGEND_UNIDENTIFIED}»`);
        return { ok: true, numberTo: i.number, name: LEGEND_UNIDENTIFIED, partialValidation: false };
    }
    // Venta global diaria.
    if (vt.kind !== "INVOICE") return fail("voucherCode", "la venta global diaria sólo agrupa facturas B o C del día (no notas de crédito ni de débito)");
    if (i.numberTo === null || i.numberTo < i.number) return fail("numberTo", "indicá el último número del rango del día (mayor o igual que el primero)");
    if (!i.belowThresholdConfirmed) return fail("belowThresholdConfirmed", "confirmá que cada comprobante del rango es menor a $ 10.000.000 (si no, va individual e identificado)");
    if (i.counterpartyName.trim().toUpperCase() !== LEGEND_GLOBAL_DAILY) return fail("counterpartyName", `en la venta global diaria la denominación es «${LEGEND_GLOBAL_DAILY}»`);
    return { ok: true, numberTo: i.numberTo, name: LEGEND_GLOBAL_DAILY, partialValidation: true };
}

/** Controles del documento 99 / rangos sobre un comprobante ya guardado (exportación). null = sin problema. */
export function unidentifiedExportProblem(inv: {
    category: string;
    voucherCode: number;
    number: number;
    numberTo: number | null;
    voucherDate: string | null;
    counterpartyDocType: number | null;
    counterpartyDocNumber: string | null;
    counterpartyName: string | null;
    totalCents: bigint;
}): string | null {
    const range = inv.numberTo !== null && inv.numberTo !== inv.number;
    if (inv.counterpartyDocType !== UNIDENTIFIED_DOC_TYPE) {
        return range ? "rango de comprobantes sin documento 99: sólo la venta global diaria se registra agrupada" : null;
    }
    const vt = VOUCHER_TYPES.find((v) => v.code === inv.voucherCode);
    if (inv.category !== "SALES") return "documento 99 en una compra: el vendedor debe estar identificado";
    if (!vt || (vt.letter !== "B" && vt.letter !== "C")) return "documento 99 en un comprobante que no es clase B o C";
    if (inv.voucherDate !== null && inv.voucherDate < THRESHOLD_VERIFIED_FROM) return "documento 99 antes del 29/05/2025: umbral de identificación no verificado";
    if (!/^0*$/.test(inv.counterpartyDocNumber ?? "")) return "documento 99 con número de documento distinto de 0";
    if (range) {
        if (vt.kind !== "INVOICE") return "venta global diaria con un comprobante que no es factura";
        if ((inv.counterpartyName ?? "").trim().toUpperCase() !== LEGEND_GLOBAL_DAILY) return `venta global diaria sin la leyenda «${LEGEND_GLOBAL_DAILY}»`;
        return null;
    }
    if (inv.totalCents >= thresholdCents) return "venta sin identificar de $ 10.000.000 o más: el comprador debe identificarse";
    return null;
}
