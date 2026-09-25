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
    /** Denominación oficial. */
    label: string;
    letter: "A" | "B" | "C" | "T";
    kind: VoucherKind;
    /** Etiqueta usada por la columna heredada `Invoice.type` (compatibilidad). */
    legacyLabel: string;
    source: OfficialSource;
}

/**
 * Tabla 3 "Tipo de Comprobante" (Tablas del Sistema). Subconjunto mínimo.
 * Clase "T" (195/196/197): comprobantes de TurIVA (pestañas "TURIVA" de Compras
 * y "Ventas por TURIVA", Especificaciones). El 063 (LIQUIDACIONES A) se difiere
 * a la fase de importación: requiere modelar corredor y comisión.
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
    { code: 96, label: "DOC NACIONAL DE IDENTIDAD", source: SOURCE_LID_TABLAS },
    { code: 99, label: "SIN IDENTIFICAR / VENTA GLOBAL DIARIA", source: SOURCE_LID_TABLAS },
];

export const DOC_TYPE_CUIT = 80;

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
