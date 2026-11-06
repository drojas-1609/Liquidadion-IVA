import type { IssueCode } from "./classification";

/**
 * Explicación y forma de resolver cada control, en lenguaje de operador (sin
 * `server-only`: lo usa la pantalla). Fuentes en lib/vat-export/classification.ts.
 */
export const ISSUE_HELP: Record<IssueCode, { title: string; fix: string }> = {
    LIQUIDATION_NOT_COMPUTABLE: { title: "La liquidación no se puede calcular", fix: "Cargá el coeficiente de prorrateo global en la configuración de IVA del período." },
    LEGACY_ROW: { title: "Comprobante del modelo anterior", fix: "Abrilo desde Ventas o Compras y guardalo: se completan sus datos con el modelo actual." },
    SALE_ACTIVITY_MISSING: { title: "Venta sin actividad", fix: "Elegí la actividad (código ARCA de la ficha del cliente) en la clasificación por lote." },
    SALE_OPERATION_TYPE_MISSING: { title: "Venta sin tipo de operación", fix: "Indicá si es venta de cosas muebles, obras, locaciones y servicios (1) o de bienes de uso (2)." },
    SALE_BUYER_TYPE_MISSING: { title: "Venta sin tipo de sujeto comprador", fix: "Elegí RI, monotributista o consumidor final/exento/no alcanzado. Se completa solo si la condición frente al IVA registrada lo determina." },
    SALE_NET_WITHOUT_BREAKDOWN: { title: "Venta sin IVA discriminado", fix: "Corregí el comprobante con sus alícuotas: la apertura exige el neto por alícuota." },
    SALE_ZERO_RATE_CODE: { title: "Venta al 0 % no contemplada en la apertura", fix: "Revisá el código de operación (sólo E, N o A integran la apertura como exentas o no gravadas)." },
    OPERATION_CODE_MISSING: { title: "Falta el código de operación", fix: "Para operaciones al 0 % o sin IVA, elegí E (exenta), N (no gravada), A (no alcanzado) u otro de la tabla oficial." },
    PURCHASE_CONCEPT_MISSING: { title: "Compra sin concepto del crédito fiscal", fix: "Elegí bienes, locaciones, servicios o bienes de uso en la clasificación por lote." },
    NAME_NOT_ANSI: { title: "Denominación con caracteres no admitidos", fix: "Editá el comprobante y reemplazá los caracteres especiales (el Libro IVA Digital usa ANSI)." },
    NAME_TRUNCATED: { title: "Denominación de más de 30 caracteres", fix: "No bloquea: el archivo lleva los primeros 30, como admite el diseño." },
    NUMBER_RANGE: { title: "Rango de comprobantes agrupado", fix: "No se exporta en esta etapa: cargá los comprobantes individuales." },
    CURRENCY_NOT_PES: { title: "Moneda distinta de pesos", fix: "No bloquea: los archivos informan los importes en pesos, como los guarda la aplicación." },
    EXPORT_VOUCHER: { title: "Exportaciones", fix: "Informativo: no integran la apertura de débito fiscal; su total figura en los conceptos a cargar en ARCA." },
    DATION_WITHOUT_VAT: { title: "Dación en pago sin débito", fix: "Revisá la marca de dación en pago (Decreto 1145/09) del comprobante." },
    GLOBAL_PRORATION_APERTURA: { title: "Crédito con prorrateo global", fix: "La apertura de crédito computable por concepto no se puede generar: cargala en ARCA. El Libro IVA Digital sí se exporta." },
    PURCHASE_NC_PARTIAL_CREDIT: { title: "Nota de crédito recibida con crédito parcial", fix: "No bloquea: la apertura restituye el crédito facturado; revisá el ajuste en ARCA." },
    TAX_RECORD_DETAIL_MISSING: { title: "Retención o percepción sin datos del F.2051", fix: "Editala desde Retenciones/Percepciones y completá naturaleza, régimen, agente, comprobante y certificado." },
    TAX_RECORD_NOT_IVA: { title: "Retención de otro impuesto", fix: "Informativo." },
    INVOICE_PERCEPTIONS_NOT_REGISTERED: { title: "Percepción de IVA del comprobante sin registrar", fix: "Registrala desde Retenciones/Percepciones eligiendo el comprobante (no se duplica). Si ya la cargaste por separado, vinculala al comprobante." },
};

export const LEVEL_LABEL = { LIQUIDATION: "Impide liquidar", EXPORT: "Impide exportar", WARNING: "Advertencia", INFO: "Información" } as const;
