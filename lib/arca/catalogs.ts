/**
 * Catálogos oficiales de ARCA usados por el modelo contable.
 *
 * REGLA: sólo se incorporan códigos verificados en documentos públicos
 * oficiales de ARCA, registrando URL y fecha de consulta. Nada de blogs, foros
 * ni documentación de terceros. Ampliar un catálogo es agregar entradas: la
 * lógica contable (signo, alícuota) depende sólo de los campos de cada entrada
 * (`kind`, `rate`), nunca del código literal.
 *
 * Sin dependencias ni `server-only`: datos puros, aptos para cliente y servidor.
 */

export interface OfficialSource {
    document: string;
    url: string;
    /** Fecha de consulta (UTC), AAAA-MM-DD. */
    retrievedAt: string;
}

/** "Libro IVA Digital – Tablas del Sistema" (alícuotas, comprobantes, monedas, documentos). */
export const SOURCE_LID_TABLAS: OfficialSource = {
    document: "Libro IVA Digital – Tablas del Sistema",
    url: "https://www.arca.gob.ar/iva/documentos/Libro-IVA-Digital-Tablas-del-Sistema.pdf",
    retrievedAt: "2026-09-25",
};

/** "Libro IVA Digital R.G. N° 4597 – Especificaciones", revisión 30/07/2025. */
export const SOURCE_LID_ESPECIFICACIONES: OfficialSource = {
    document: "Libro IVA Digital R.G. N° 4597 – Especificaciones (Revisión 30/07/2025)",
    url: "https://www.afip.gob.ar/iva/documentos/Libro-IVA-Digital-Especificaciones.pdf",
    retrievedAt: "2026-09-25",
};

/** "Tipos de responsables" (Factura Electrónica), V.0 del 06/02/2025. */
export const SOURCE_TIPOS_RESPONSABLES: OfficialSource = {
    document: "Tipos de responsables (TABLA-TIPO-RESPONSABLES-V.0-06022025)",
    url: "https://www.afip.gob.ar/fe/documentos/TABLA-TIPO-RESPONSABLES-V.0-06022025.xls",
    retrievedAt: "2026-09-25",
};

/** ARCA · Régimen general — clases de comprobantes a emitir. */
export const SOURCE_ARCA_COMPROBANTES: OfficialSource = {
    document: "ARCA — Régimen general (Facturación, comprobantes)",
    url: "https://www.arca.gob.ar/facturacion/regimen-general/comprobantes.asp",
    retrievedAt: "2026-09-25",
};

/** RG 1415/2003 (texto consolidado y versiones anteriores): arts. 15, 16, 17; Anexo II A e). */
export const SOURCE_RG_1415: OfficialSource = {
    document: "Resolución General 1415/2003",
    url: "https://biblioteca.afip.gob.ar/search/query/norma.aspx?p=t:RAG|n:1415|o:3|a:2003|f:07/01/2003",
    retrievedAt: "2026-09-25",
};

/** RG 5003/2021: art. 20 (RG 1415 art. 15), art. 21 (RG 1575 art. 6), art. 28 b) — Título V desde 01/07/2021. */
export const SOURCE_RG_5003: OfficialSource = {
    document: "Resolución General 5003/2021",
    url: "https://biblioteca.afip.gob.ar/search/query/norma.aspx?p=t:RAG|n:5003|o:3|a:2021|f:31/05/2021",
    retrievedAt: "2026-09-25",
};

/** RG 1575/2003 (abrogada por RG 5762): arts. 5, 6, 10, 11, 21 y 35 — aplicación desde 20/10/2003. */
export const SOURCE_RG_1575: OfficialSource = {
    document: "Resolución General 1575/2003 (abrogada)",
    url: "https://biblioteca.afip.gob.ar/search/query/norma.aspx?p=t:RAG|n:1575|o:3|a:2003|f:10/10/2003",
    retrievedAt: "2026-09-25",
};

/** RG 4627/2019: arts. 1, 3 y 6 — vigente desde 11/11/2019. */
export const SOURCE_RG_4627: OfficialSource = {
    document: "Resolución General 4627/2019 (abrogada)",
    url: "https://biblioteca.afip.gob.ar/search/query/norma.aspx?p=t:RAG%7Cn:4627%7Co:3%7Ca:2019%7Cf:05/11/2019",
    retrievedAt: "2026-09-25",
};

/** RG 5762/2025: arts. 11, 21, 27, 28, 30, 31 y 32 — vigente desde 01/12/2025. */
export const SOURCE_RG_5762: OfficialSource = {
    document: "Resolución General 5762/2025",
    url: "https://biblioteca.afip.gob.ar/search/query/norma.aspx?p=t%3ARAG%7Cn%3A5762%7Co%3A9%7Ca%3A2025%7Cf%3A24%2F09%2F2025",
    retrievedAt: "2026-09-25",
};

/** RG Conjunta 3971/2016: arts. 1, 4, 5, 6 y 21 — clase T desde 01/04/2017. */
export const SOURCE_RGC_3971: OfficialSource = {
    document: "Resolución General Conjunta 3971/2016",
    url: "https://biblioteca.afip.gob.ar/search/query/norma.aspx?p=t:RAG|n:3971|o:3|a:2016|f:28/12/2016",
    retrievedAt: "2026-09-25",
};

/** Decreto 1043/2016: régimen de reintegro del IVA a turistas del extranjero. */
export const SOURCE_DEC_1043: OfficialSource = {
    document: "Decreto 1043/2016",
    url: "https://biblioteca.afip.gob.ar/dcp/DEC_C_001043_2016_09_27",
    retrievedAt: "2026-09-25",
};

/** Régimen informativo F.8089 (TurIVA alojamiento), versión 1.3 del 06/07/2017: 4.1, 4.2 y tabla 6.1. */
export const SOURCE_TURIVA_F8089: OfficialSource = {
    document: "Reintegro del IVA facturado por servicios de alojamiento a turistas extranjeros — Régimen informativo (V1.3, 06/07/2017)",
    url: "https://www.afip.gob.ar/fe/documentos/ManualRegimenInformativoAlojamientoTuristasExtranjerosV1_3Modificado06072017.pdf",
    retrievedAt: "2026-09-25",
};

/** Ley 26.565, Anexo: arts. 11 (Monotributo Social) y 31 (Promovido) dentro del RS. */
export const SOURCE_LEY_26565: OfficialSource = {
    document: "Ley 26.565 (Anexo)",
    url: "https://biblioteca.afip.gob.ar/dcp/LEY_C_026565_2009_11_25",
    retrievedAt: "2026-09-25",
};

/** ARCA · Monotributo promovido — emite facturas clase C. */
export const SOURCE_MONOTRIBUTO_PROMOVIDO: OfficialSource = {
    document: "ARCA — Facturación y pagos, Monotributo promovido",
    url: "https://www.afip.gob.ar/monotributo/monotributo-promovido/facturacion/",
    retrievedAt: "2026-09-25",
};

/** Factura Electrónica · "Tipos de Comprobantes" (tabla actual, sin fecha de versión). */
export const SOURCE_FE_TABLA_COMPROBANTES: OfficialSource = {
    document: "Factura Electrónica — Tipos de Comprobantes (TABLACOMPROBANTES)",
    url: "https://www.afip.gob.ar/fe/documentos/TABLACOMPROBANTES.xls",
    retrievedAt: "2026-09-25",
};

// ── Alícuotas de IVA ──────────────────────────────────────────────────────

export interface VatRateEntry {
    code: number;
    /** Porcentaje como string decimal exacto (se convierte con Prisma.Decimal). */
    rate: string;
    source: OfficialSource;
}

/** Tabla 1 "Alícuotas del IVA" (Tablas del Sistema). */
export const VAT_RATES: readonly VatRateEntry[] = [
    { code: 3, rate: "0", source: SOURCE_LID_TABLAS },
    { code: 4, rate: "10.5", source: SOURCE_LID_TABLAS },
    { code: 5, rate: "21", source: SOURCE_LID_TABLAS },
    { code: 6, rate: "27", source: SOURCE_LID_TABLAS },
    { code: 8, rate: "5", source: SOURCE_LID_TABLAS },
    { code: 9, rate: "2.5", source: SOURCE_LID_TABLAS },
];

// ── Tipos de comprobante ──────────────────────────────────────────────────

export type VoucherKind = "INVOICE" | "DEBIT_NOTE" | "CREDIT_NOTE";

export interface VoucherTypeEntry {
    code: number;
    /** Denominación oficial (técnica) de la Tabla 3. */
    label: string;
    /**
     * Letra TÉCNICA de la denominación. Para 051–053 es "M" en la tabla, pero la
     * clase jurídica depende de la fecha (lib/arca/voucher-legal-class.ts).
     */
    letter: "A" | "B" | "C" | "E" | "M" | "T";
    kind: VoucherKind;
    /**
     * Etiqueta usada por la columna heredada `Invoice.type` y por el contrato
     * anterior del alta. NULL = código NO admitido por el contrato anterior
     * (sólo se cargará con el contrato nuevo, que aplica la matriz normativa).
     */
    legacyLabel: string | null;
    source: OfficialSource;
}

/**
 * Tabla 3 "Tipo de Comprobante" (Tablas del Sistema). Subconjunto mínimo.
 * Clase "T" (195/196/197): comprobantes de TurIVA (pestañas "TURIVA" de Compras
 * y "Ventas por TURIVA", Especificaciones). El 063 (LIQUIDACIONES A) se difiere
 * a la fase de importación: requiere modelar corredor y comisión.
 * 019–021 (exportación) y 051–053 se agregan sin etiqueta heredada: sólo los
 * admite el contrato nuevo, con la matriz de lib/arca/voucher-matrix.ts.
 */
export const VOUCHER_TYPES: readonly VoucherTypeEntry[] = [
    { code: 1, label: "FACTURAS A", letter: "A", kind: "INVOICE", legacyLabel: "FC A", source: SOURCE_LID_TABLAS },
    { code: 2, label: "NOTAS DE DEBITO A", letter: "A", kind: "DEBIT_NOTE", legacyLabel: "ND A", source: SOURCE_LID_TABLAS },
    { code: 3, label: "NOTAS DE CREDITO A", letter: "A", kind: "CREDIT_NOTE", legacyLabel: "NC A", source: SOURCE_LID_TABLAS },
    { code: 6, label: "FACTURAS B", letter: "B", kind: "INVOICE", legacyLabel: "FC B", source: SOURCE_LID_TABLAS },
    { code: 7, label: "NOTAS DE DEBITO B", letter: "B", kind: "DEBIT_NOTE", legacyLabel: "ND B", source: SOURCE_LID_TABLAS },
    { code: 8, label: "NOTAS DE CREDITO B", letter: "B", kind: "CREDIT_NOTE", legacyLabel: "NC B", source: SOURCE_LID_TABLAS },
    { code: 11, label: "FACTURAS C", letter: "C", kind: "INVOICE", legacyLabel: "FC C", source: SOURCE_LID_TABLAS },
    { code: 12, label: "NOTAS DE DEBITO C", letter: "C", kind: "DEBIT_NOTE", legacyLabel: "ND C", source: SOURCE_LID_TABLAS },
    { code: 13, label: "NOTAS DE CREDITO C", letter: "C", kind: "CREDIT_NOTE", legacyLabel: "NC C", source: SOURCE_LID_TABLAS },
    { code: 19, label: "FACTURAS DE EXPORTACION", letter: "E", kind: "INVOICE", legacyLabel: null, source: SOURCE_LID_TABLAS },
    { code: 20, label: "NOTAS DE DEBITO POR OPERACIONES CON EL EXTERIOR", letter: "E", kind: "DEBIT_NOTE", legacyLabel: null, source: SOURCE_LID_TABLAS },
    { code: 21, label: "NOTAS DE CREDITO POR OPERACIONES CON EL EXTERIOR", letter: "E", kind: "CREDIT_NOTE", legacyLabel: null, source: SOURCE_LID_TABLAS },
    { code: 51, label: "FACTURAS M", letter: "M", kind: "INVOICE", legacyLabel: null, source: SOURCE_LID_TABLAS },
    { code: 52, label: "NOTAS DE DEBITO M", letter: "M", kind: "DEBIT_NOTE", legacyLabel: null, source: SOURCE_LID_TABLAS },
    { code: 53, label: "NOTAS DE CREDITO M", letter: "M", kind: "CREDIT_NOTE", legacyLabel: null, source: SOURCE_LID_TABLAS },
    { code: 195, label: "FACTURA CLASE “T”", letter: "T", kind: "INVOICE", legacyLabel: "FC T", source: SOURCE_LID_TABLAS },
    { code: 196, label: "NOTA DE DÉBITO CLASE “T”", letter: "T", kind: "DEBIT_NOTE", legacyLabel: "ND T", source: SOURCE_LID_TABLAS },
    { code: 197, label: "NOTA DE CRÉDITO CLASE “T”", letter: "T", kind: "CREDIT_NOTE", legacyLabel: "NC T", source: SOURCE_LID_TABLAS },
];

// ── Tipos de documento ────────────────────────────────────────────────────

export interface DocumentTypeEntry {
    code: number;
    label: string;
    source: OfficialSource;
}

/** Anexo "Tipo de Documento" (Tablas del Sistema). Subconjunto mínimo. */
export const DOCUMENT_TYPES: readonly DocumentTypeEntry[] = [
    { code: 80, label: "CUIT", source: SOURCE_LID_TABLAS },
    { code: 86, label: "CUIL", source: SOURCE_LID_TABLAS },
    { code: 91, label: "C I EXTRANJERA", source: SOURCE_LID_TABLAS },
    { code: 94, label: "PASAPORTE", source: SOURCE_LID_TABLAS },
    { code: 96, label: "DOC NACIONAL DE IDENTIDAD", source: SOURCE_LID_TABLAS },
    { code: 99, label: "SIN IDENTIFICAR / VENTA GLOBAL DIARIA", source: SOURCE_LID_TABLAS },
];

export const DOC_TYPE_CUIT = 80;
export const DOC_TYPE_CI_EXTRANJERA = 91;
export const DOC_TYPE_PASAPORTE = 94;
export const DOC_TYPE_DNI = 96;

// ── Condición frente al IVA ───────────────────────────────────────────────

export interface VatConditionEntry {
    code: number;
    /** Descripción literal de la tabla oficial. */
    label: string;
    source: OfficialSource;
}

/** "Tipos de responsables" (celdas A4:B14, valores literales). */
export const VAT_CONDITIONS: readonly VatConditionEntry[] = [
    { code: 1, label: "IVA Responsable Inscripto", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 4, label: "IVA Sujeto Exento", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 5, label: "Consumidor Final", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 6, label: "Responsable Monotributo", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 7, label: "Sujeto no Categorizado", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 8, label: "Proveedor del Exterior", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 9, label: "Cliente del Exterior", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 10, label: "IVA Liberado – Ley Nº 19.640", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 13, label: "Monotributista Social", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 15, label: "IVA No Alcanzado", source: SOURCE_TIPOS_RESPONSABLES },
    { code: 16, label: "Monotributo Trabajador Independiente Promovido", source: SOURCE_TIPOS_RESPONSABLES },
];

export const VAT_CONDITION_RI = 1;
export const VAT_CONDITION_EXENTO = 4;
export const VAT_CONDITION_CONSUMIDOR_FINAL = 5;
export const VAT_CONDITION_MONOTRIBUTO = 6;
export const VAT_CONDITION_NO_CATEGORIZADO = 7;
export const VAT_CONDITION_PROVEEDOR_EXTERIOR = 8;
export const VAT_CONDITION_CLIENTE_EXTERIOR = 9;
export const VAT_CONDITION_LIBERADO_19640 = 10;
export const VAT_CONDITION_MONOTRIBUTO_SOCIAL = 13;
export const VAT_CONDITION_NO_ALCANZADO = 15;
export const VAT_CONDITION_MONOTRIBUTO_PROMOVIDO = 16;

// ── TurIVA: relación emisor-receptor ──────────────────────────────────────

export interface TurivaRelationEntry {
    /** Texto de 4 caracteres con ceros a la izquierda. */
    code: "0001" | "0002" | "0003" | "0004" | "0005" | "0006";
    label: string;
    source: OfficialSource;
}

/** Tabla 6.1 "Relación Emisor Receptor Comprobante T" (régimen informativo F.8089). */
export const TURIVA_RELATIONS: readonly TurivaRelationEntry[] = [
    { code: "0001", label: "Alojamiento Directo a Turista No Residente (Persona Física o Jurídica)", source: SOURCE_TURIVA_F8089 },
    { code: "0002", label: "Alojamiento a Agencia de Viaje Residente", source: SOURCE_TURIVA_F8089 },
    { code: "0003", label: "Alojamiento a Agencia de Viaje No Residente", source: SOURCE_TURIVA_F8089 },
    { code: "0004", label: "Agencia de Viaje Residente a Agencia de Viaje No Residente", source: SOURCE_TURIVA_F8089 },
    { code: "0005", label: "Agencia de Viaje Residente a Turista No Residente (Persona Física o Jurídica)", source: SOURCE_TURIVA_F8089 },
    { code: "0006", label: "Agencia de Viaje Residente a Agencia de Viaje Residente", source: SOURCE_TURIVA_F8089 },
];

// ── Variante de comprobante (001–003) ─────────────────────────────────────

export type VoucherVariant = "NONE" | "PAGO_EN_CBU_INFORMADA";

export interface VoucherVariantEntry {
    code: VoucherVariant;
    label: string;
    sources: readonly OfficialSource[];
}

/**
 * Dominio inicial de `Invoice.voucherVariant` (sólo 001–003, cargas manuales).
 * La clase A con leyenda de retención de 11/11/2019–30/11/2025 NO integra el
 * dominio: su código histórico no está confirmado (pendiente normativo).
 */
export const VOUCHER_VARIANTS: readonly VoucherVariantEntry[] = [
    { code: "NONE", label: "Sin variante", sources: [SOURCE_RG_1415] },
    { code: "PAGO_EN_CBU_INFORMADA", label: "Con leyenda \"PAGO EN CBU INFORMADA\"", sources: [SOURCE_RG_1575, SOURCE_RG_4627, SOURCE_RG_5762] },
];

// ── Monedas ───────────────────────────────────────────────────────────────

export interface CurrencyEntry {
    code: string;
    label: string;
    source: OfficialSource;
}

/** Anexo "Código de Moneda" (Tablas del Sistema). Sólo pesos hasta ampliar. */
export const CURRENCIES: readonly CurrencyEntry[] = [
    { code: "PES", label: "PESOS ARGENTINOS", source: SOURCE_LID_TABLAS },
];

export const CURRENCY_PESOS = "PES";

// ── Códigos de operación ──────────────────────────────────────────────────

export interface OperationCodeEntry {
    /** "0" representa "(espacio) o 0 — No corresponde". */
    code: string;
    purchasesLabel: string;
    salesLabel: string;
    source: OfficialSource;
}

/** Tabla 2 "Códigos de Operación" (Tablas del Sistema). */
export const OPERATION_CODES: readonly OperationCodeEntry[] = [
    { code: "0", purchasesLabel: "No corresponde", salesLabel: "No corresponde", source: SOURCE_LID_TABLAS },
    { code: "A", purchasesLabel: "No Alcanzado", salesLabel: "No Alcanzado", source: SOURCE_LID_TABLAS },
    { code: "C", purchasesLabel: "Operac. Canje", salesLabel: "Operac. Canje", source: SOURCE_LID_TABLAS },
    { code: "D", purchasesLabel: "Devol. IVA Turistas Extr.", salesLabel: "Devol. IVA Turistas Extr", source: SOURCE_LID_TABLAS },
    { code: "E", purchasesLabel: "Operaciones Exentas", salesLabel: "Operaciones Exentas", source: SOURCE_LID_TABLAS },
    { code: "N", purchasesLabel: "No gravado", salesLabel: "No gravado", source: SOURCE_LID_TABLAS },
    { code: "T", purchasesLabel: "Reintegro Decreto 1043/2016", salesLabel: "Reintegro Decreto 1043/2016", source: SOURCE_LID_TABLAS },
    { code: "X", purchasesLabel: "Importación del Exterior", salesLabel: "Exportación al Exterior", source: SOURCE_LID_TABLAS },
    { code: "Z", purchasesLabel: "Importación de Zona Franca", salesLabel: "Exportación a Zona Franca", source: SOURCE_LID_TABLAS },
];

// ── Reglas respaldadas por documentación oficial ──────────────────────────

/**
 * Compras: los comprobantes que no discriminan IVA — tipo 'B' o 'C' — informan
 * "Cantidad de alícuotas de IVA" = 0 y no llevan registros de alícuotas
 * (Especificaciones, Libro Compras, campo 19 y archivo COMPRAS_ALICUOTAS).
 */
export const RULE_PURCHASES_BC_NO_VAT_LINES = {
    letters: ["B", "C"] as const,
    source: SOURCE_LID_ESPECIFICACIONES,
};

/**
 * Crédito Fiscal Computable: sin prorrateo, "idéntico valor al del impuesto
 * liquidado" (Especificaciones, Libro Compras, campo 21).
 */
export const RULE_COMPUTABLE_CREDIT_DEFAULT = { source: SOURCE_LID_ESPECIFICACIONES };

/**
 * Modalidades del crédito fiscal computable, elegidas POR PERÍODO: sin
 * prorrateo; con prorrateo por asignación directa; global; o asignación
 * directa y global. Con prorrateo global, el comprobante informa 0 y el
 * crédito se determina en la pestaña "CF Computable Global" del período
 * (Especificaciones, "Datos iniciales" y Libro Compras campo 21).
 */
export const RULE_CREDIT_PRORATION_MODES = { source: SOURCE_LID_ESPECIFICACIONES };

/**
 * TurIVA: opción del período "Incluido en el Régimen TurIVA", que habilita las
 * pestañas "TURIVA" (Compras) y "Ventas por TURIVA"; importe del Reintegro
 * Decreto 1043/2016 en Ventas campo 23 y Compras campo 26 (Especificaciones).
 */
export const RULE_TURIVA = { source: SOURCE_LID_ESPECIFICACIONES };
