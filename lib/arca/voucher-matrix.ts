import {
    SOURCE_ARCA_COMPROBANTES,
    SOURCE_LEY_26565,
    SOURCE_LID_ESPECIFICACIONES,
    SOURCE_MONOTRIBUTO_PROMOVIDO,
    SOURCE_RG_1415,
    SOURCE_RG_1575,
    SOURCE_RG_4627,
    SOURCE_RG_5003,
    SOURCE_RG_5762,
    SOURCE_RGC_3971,
    SOURCE_TURIVA_F8089,
    TURIVA_RELATIONS,
    DOC_TYPE_CUIT,
    DOC_TYPE_CI_EXTRANJERA,
    DOC_TYPE_PASAPORTE,
    DOC_TYPE_DNI,
    type OfficialSource,
    type VoucherVariant,
} from "./catalogs";

/**
 * Matriz normativa de comprobantes para la carga MANUAL (research-report.md §3).
 *
 * Cada fila vincula emisor, receptor (condiciones oficiales de "Tipos de
 * responsables"), vigencia, códigos y variante con su estado y fuente:
 *   - ALLOWED: combinación legalmente posible. No implica que el emisor pueda
 *     elegir libremente la clase o la variante: dependen de su autorización o
 *     calificación fiscal, que el sistema no puede verificar.
 *   - PENDING: sin fuente oficial suficiente. Fuera del selector.
 * Toda combinación sin fila ALLOWED se rechaza.
 *
 * Emisor/receptor: en VENTAS el emisor es el cliente del estudio y el receptor
 * la contraparte; en COMPRAS, al revés.
 *
 * Fechas como texto ISO `AAAA-MM-DD` (día calendario). `from`/`to` inclusivos;
 * null = sin límite. Ninguna regla depende de IIBB (Convenio Multilateral fuera
 * de alcance). El 063 no integra la carga manual.
 *
 * Lógica pura, sin `server-only`. Todavía NO se usa en el alta (etapa 3).
 */

export type Direction = "SALES" | "PURCHASES";
export type RuleStatus = "ALLOWED" | "PENDING";

export const CODES_A = [1, 2, 3] as const;
export const CODES_B = [6, 7, 8] as const;
export const CODES_C = [11, 12, 13] as const;
export const CODES_E = [19, 20, 21] as const;
export const CODES_M = [51, 52, 53] as const;
export const CODES_T = [195, 196, 197] as const;

/** Fecha mínima de la clase T (RG Conjunta 3971/2016, art. 21 inc. a). */
export const TURIVA_T_START = "2017-04-01";

export interface MatrixRow {
    id: string;
    direction: Direction;
    issuers: readonly number[];
    receivers: readonly number[];
    from: string | null;
    to: string | null;
    codes: readonly number[];
    /** Variantes admitidas; [null] = el código no lleva variante almacenada. */
    variants: readonly (VoucherVariant | null)[];
    status: RuleStatus;
    sources: readonly OfficialSource[];
    note?: string;
}

const NONE: VoucherVariant = "NONE";
const CBU: VoucherVariant = "PAGO_EN_CBU_INFORMADA";
const RS = [6, 13, 16] as const;
const CBU_1575 = { from: "2003-10-20", to: "2019-11-10" } as const;
const CBU_5762 = { from: "2025-12-01", to: null } as const;
const OSR_PENDING_NOTE =
    "Clase A con leyenda OPERACIÓN SUJETA A RETENCIÓN (11/11/2019–30/11/2025): código no confirmado; no se almacena como variante.";

const row = (r: MatrixRow): MatrixRow => r;

export const VOUCHER_MATRIX: readonly MatrixRow[] = [
    // ── Ventas ────────────────────────────────────────────────────────────
    row({ id: "V1", direction: "SALES", issuers: [1], receivers: [1], from: null, to: null, codes: CODES_A, variants: [NONE], status: "ALLOWED", sources: [SOURCE_RG_1415] }),
    row({ id: "V2", direction: "SALES", issuers: [1], receivers: [1], ...CBU_1575, codes: CODES_A, variants: [CBU], status: "ALLOWED", sources: [SOURCE_RG_1575, SOURCE_RG_4627] }),
    row({ id: "V4", direction: "SALES", issuers: [1], receivers: [1], from: "2019-11-11", to: "2025-11-30", codes: CODES_A, variants: [], status: "PENDING", sources: [SOURCE_RG_1575, SOURCE_RG_4627], note: OSR_PENDING_NOTE }),
    row({ id: "V5", direction: "SALES", issuers: [1], receivers: [1], ...CBU_5762, codes: CODES_A, variants: [CBU], status: "ALLOWED", sources: [SOURCE_RG_5762] }),
    row({ id: "V7", direction: "SALES", issuers: [1], receivers: [1], from: "2003-10-20", to: "2019-11-10", codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1575] }),
    row({ id: "V8", direction: "SALES", issuers: [1], receivers: [1], from: "2019-11-11", to: "2025-11-30", codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1575, SOURCE_RG_4627] }),
    row({ id: "V9", direction: "SALES", issuers: [1], receivers: [1], from: "2025-12-01", to: null, codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_5762] }),
    row({ id: "V11", direction: "SALES", issuers: [1], receivers: RS, from: null, to: "2021-06-30", codes: CODES_B, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_RG_5003, SOURCE_LEY_26565] }),
    row({ id: "V13", direction: "SALES", issuers: [1], receivers: RS, from: "2021-07-01", to: null, codes: CODES_A, variants: [NONE], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_RG_5003] }),
    row({ id: "V14", direction: "SALES", issuers: [1], receivers: RS, from: "2021-07-01", to: "2025-11-30", codes: CODES_A, variants: [], status: "PENDING", sources: [SOURCE_RG_1575, SOURCE_RG_4627], note: OSR_PENDING_NOTE }),
    row({ id: "V15", direction: "SALES", issuers: [1], receivers: RS, from: "2021-07-01", to: "2025-11-30", codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1575, SOURCE_RG_4627, SOURCE_RG_5003] }),
    row({ id: "V16", direction: "SALES", issuers: [1], receivers: RS, ...CBU_5762, codes: CODES_A, variants: [CBU], status: "ALLOWED", sources: [SOURCE_RG_5762, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "V17", direction: "SALES", issuers: [1], receivers: RS, from: "2025-12-01", to: null, codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_5762, SOURCE_RG_1415] }),
    row({ id: "V18", direction: "SALES", issuers: [1], receivers: [4, 5, 7, 15], from: null, to: null, codes: CODES_B, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "V19", direction: "SALES", issuers: [1], receivers: [9], from: null, to: null, codes: CODES_E, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "V20", direction: "SALES", issuers: [4], receivers: [9], from: null, to: null, codes: CODES_E, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "V21", direction: "SALES", issuers: [6], receivers: [9], from: null, to: null, codes: CODES_E, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "V22", direction: "SALES", issuers: [4], receivers: [1, 4, 5, 6, 7, 13, 15, 16], from: null, to: null, codes: CODES_C, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "V23", direction: "SALES", issuers: [6], receivers: [1, 4, 5, 6, 7, 13, 15, 16], from: null, to: null, codes: CODES_C, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "V24", direction: "SALES", issuers: [1], receivers: [9], from: null, to: null, codes: CODES_B, variants: [], status: "PENDING", sources: [SOURCE_ARCA_COMPROBANTES], note: "Clase B a receptor 9 sin correspondencia expresa." }),
    row({ id: "V25", direction: "SALES", issuers: [1, 4, 6], receivers: [8, 10], from: null, to: null, codes: [], variants: [], status: "PENDING", sources: [], note: "Condiciones 8 y 10 sin fuente expresa." }),

    // ── Compras ───────────────────────────────────────────────────────────
    row({ id: "C1", direction: "PURCHASES", issuers: [1], receivers: [1], from: null, to: null, codes: CODES_A, variants: [NONE], status: "ALLOWED", sources: [SOURCE_RG_1415] }),
    row({ id: "C2", direction: "PURCHASES", issuers: [1], receivers: [1], ...CBU_1575, codes: CODES_A, variants: [CBU], status: "ALLOWED", sources: [SOURCE_RG_1575, SOURCE_RG_4627] }),
    row({ id: "C4", direction: "PURCHASES", issuers: [1], receivers: [1], from: "2019-11-11", to: "2025-11-30", codes: CODES_A, variants: [], status: "PENDING", sources: [SOURCE_RG_1575, SOURCE_RG_4627], note: OSR_PENDING_NOTE }),
    row({ id: "C5", direction: "PURCHASES", issuers: [1], receivers: [1], ...CBU_5762, codes: CODES_A, variants: [CBU], status: "ALLOWED", sources: [SOURCE_RG_5762] }),
    row({ id: "C7", direction: "PURCHASES", issuers: [1], receivers: [1], from: "2003-10-20", to: "2019-11-10", codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1575] }),
    row({ id: "C8", direction: "PURCHASES", issuers: [1], receivers: [1], from: "2019-11-11", to: "2025-11-30", codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1575, SOURCE_RG_4627] }),
    row({ id: "C9", direction: "PURCHASES", issuers: [1], receivers: [1], from: "2025-12-01", to: null, codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_5762] }),
    row({ id: "C11", direction: "PURCHASES", issuers: [1], receivers: [6], from: null, to: "2021-06-30", codes: CODES_B, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_RG_5003] }),
    row({ id: "C13", direction: "PURCHASES", issuers: [1], receivers: [6], from: "2021-07-01", to: null, codes: CODES_A, variants: [NONE], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_RG_5003] }),
    row({ id: "C14", direction: "PURCHASES", issuers: [1], receivers: [6], from: "2021-07-01", to: "2025-11-30", codes: CODES_A, variants: [], status: "PENDING", sources: [SOURCE_RG_1575, SOURCE_RG_4627], note: OSR_PENDING_NOTE }),
    row({ id: "C15", direction: "PURCHASES", issuers: [1], receivers: [6], from: "2021-07-01", to: "2025-11-30", codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1575, SOURCE_RG_4627, SOURCE_RG_5003] }),
    row({ id: "C16", direction: "PURCHASES", issuers: [1], receivers: [6], ...CBU_5762, codes: CODES_A, variants: [CBU], status: "ALLOWED", sources: [SOURCE_RG_5762, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "C17", direction: "PURCHASES", issuers: [1], receivers: [6], from: "2025-12-01", to: null, codes: CODES_M, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_5762, SOURCE_RG_1415] }),
    row({ id: "C18", direction: "PURCHASES", issuers: [1], receivers: [4], from: null, to: null, codes: CODES_B, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "C19-21", direction: "PURCHASES", issuers: [4], receivers: [1, 4, 6], from: null, to: null, codes: CODES_C, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "C22-24", direction: "PURCHASES", issuers: [6], receivers: [1, 4, 6], from: null, to: null, codes: CODES_C, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_ARCA_COMPROBANTES] }),
    row({ id: "C25", direction: "PURCHASES", issuers: [13], receivers: [1, 4, 6], from: null, to: null, codes: CODES_C, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_LEY_26565] }),
    row({ id: "C26", direction: "PURCHASES", issuers: [16], receivers: [1, 4, 6], from: null, to: null, codes: CODES_C, variants: [null], status: "ALLOWED", sources: [SOURCE_RG_1415, SOURCE_LEY_26565, SOURCE_MONOTRIBUTO_PROMOVIDO] }),
    row({ id: "C27", direction: "PURCHASES", issuers: [15], receivers: [1, 4, 6], from: null, to: null, codes: CODES_C, variants: [], status: "PENDING", sources: [SOURCE_RG_1415], note: "Emisor 15 (IVA No Alcanzado) sin fuente expresa para clase C." }),
    row({ id: "C28", direction: "PURCHASES", issuers: [8, 10], receivers: [1, 4, 6], from: null, to: null, codes: [], variants: [], status: "PENDING", sources: [], note: "Condiciones 8 y 10 sin fuente expresa." }),
];

// ── TurIVA ────────────────────────────────────────────────────────────────

export interface TurivaRow {
    id: string;
    direction: Direction;
    issuers: readonly number[];
    receivers: readonly number[];
    relations: readonly string[];
    sources: readonly OfficialSource[];
}

const TURIVA_SOURCES = [SOURCE_RGC_3971, SOURCE_TURIVA_F8089, SOURCE_LID_ESPECIFICACIONES];

/** research-report.md §3.3 y §3.4 (todas desde 01/04/2017, códigos 195–197, sin variante). */
export const TURIVA_MATRIX: readonly TurivaRow[] = [
    { id: "TV1", direction: "SALES", issuers: [1], receivers: [1], relations: ["0002", "0006"], sources: TURIVA_SOURCES },
    { id: "TV2", direction: "SALES", issuers: [1], receivers: [5, 9], relations: ["0001", "0005"], sources: TURIVA_SOURCES },
    { id: "TV3", direction: "SALES", issuers: [1], receivers: [5, 9], relations: ["0003", "0004"], sources: TURIVA_SOURCES },
    { id: "TC1", direction: "PURCHASES", issuers: [1], receivers: [1], relations: ["0002", "0006"], sources: TURIVA_SOURCES },
];

/** Documentos admitidos para el receptor de un comprobante T (F.8089, 3.2 campo 6). */
export const TURIVA_RECEIVER_DOC_TYPES = [DOC_TYPE_CUIT, DOC_TYPE_CI_EXTRANJERA, DOC_TYPE_PASAPORTE, DOC_TYPE_DNI] as const;

/** Datos que el modelo no tiene: todo comprobante T se marca con validación parcial. */
export const TURIVA_PARTIAL_VALIDATION_MESSAGE =
    "Validación parcial TurIVA: no se verifican país del receptor, tabla CUIT País, actividad del emisor, forma de pago internacional, datos de turistas y reintegro, ni el método de emisión.";

// ── Consultas ─────────────────────────────────────────────────────────────

const inRange = (r: { from: string | null; to: string | null }, d: string) =>
    (r.from === null || d >= r.from) && (r.to === null || d <= r.to);

function parties(direction: Direction, clientCondition: number, counterpartyCondition: number) {
    return direction === "SALES"
        ? { issuer: clientCondition, receiver: counterpartyCondition }
        : { issuer: counterpartyCondition, receiver: clientCondition };
}

const isTurivaCode = (code: number) => (CODES_T as readonly number[]).includes(code);
const isVariantCode = (code: number) => (CODES_A as readonly number[]).includes(code);

/**
 * Códigos que el selector puede ofrecer: sólo filas ALLOWED (incluye T si
 * alguna fila TurIVA admite el par emisor/receptor desde 01/04/2017).
 */
export function allowedVoucherCodes(
    direction: Direction,
    clientCondition: number | null,
    counterpartyCondition: number | null,
    dateIso: string,
): number[] {
    if (clientCondition === null || counterpartyCondition === null) return [];
    const { issuer, receiver } = parties(direction, clientCondition, counterpartyCondition);
    const codes = new Set<number>();
    for (const r of VOUCHER_MATRIX) {
        if (r.status !== "ALLOWED" || r.direction !== direction || !inRange(r, dateIso)) continue;
        if (r.issuers.includes(issuer) && r.receivers.includes(receiver)) r.codes.forEach((c) => codes.add(c));
    }
    if (dateIso >= TURIVA_T_START && TURIVA_MATRIX.some((t) => t.direction === direction && t.issuers.includes(issuer) && t.receivers.includes(receiver))) {
        CODES_T.forEach((c) => codes.add(c));
    }
    return [...codes].sort((a, b) => a - b);
}

/** Variantes que el selector puede ofrecer para un código A (vacío para los demás). */
export function allowedVoucherVariants(
    direction: Direction,
    clientCondition: number | null,
    counterpartyCondition: number | null,
    voucherCode: number,
    dateIso: string,
): VoucherVariant[] {
    if (clientCondition === null || counterpartyCondition === null || !isVariantCode(voucherCode)) return [];
    const { issuer, receiver } = parties(direction, clientCondition, counterpartyCondition);
    const out = new Set<VoucherVariant>();
    for (const r of VOUCHER_MATRIX) {
        if (r.status !== "ALLOWED" || r.direction !== direction || !inRange(r, dateIso)) continue;
        if (!r.issuers.includes(issuer) || !r.receivers.includes(receiver) || !r.codes.includes(voucherCode)) continue;
        for (const v of r.variants) if (v !== null) out.add(v);
    }
    return [...out];
}

export interface VoucherCheckInput {
    direction: Direction;
    /** Código oficial de la condición del cliente (null = texto guardado fuera de las 3 etiquetas). */
    clientCondition: number | null;
    counterpartyCondition: number | null;
    voucherCode: number;
    dateIso: string;
    /** Variante elegida (nuevas cargas manuales 001–003); null en todo otro caso. */
    voucherVariant: VoucherVariant | null;
    turivaRelationCode: string | null;
    counterpartyDocType: number | null;
}

export type VoucherCheckField =
    | "clientCondition"
    | "counterpartyVatConditionCode"
    | "voucherCode"
    | "voucherVariant"
    | "turivaRelationCode"
    | "counterpartyDocType"
    | "date";

export type VoucherCheck =
    | { ok: true; rowId: string; partialValidation: boolean; requiresTurivaSection: boolean }
    | { ok: false; field: VoucherCheckField; error: string; pending: boolean };

const reject = (field: VoucherCheckField, error: string, pending = false): VoucherCheck => ({ ok: false, field, error, pending });

/** Valida una combinación para una NUEVA carga manual. */
export function checkVoucherCombination(i: VoucherCheckInput): VoucherCheck {
    if (i.clientCondition === null) {
        return reject("clientCondition", "la condición fiscal del cliente no es una de las admitidas (Responsable Inscripto, Monotributo, Exento)");
    }
    if (i.counterpartyCondition === null) return reject("counterpartyVatConditionCode", "condición fiscal de la contraparte requerida");

    if (isVariantCode(i.voucherCode)) {
        if (i.voucherVariant === null) return reject("voucherVariant", "variante requerida para comprobantes 001, 002 y 003");
    } else if (i.voucherVariant !== null) {
        return reject("voucherVariant", "la variante sólo corresponde a comprobantes 001, 002 y 003");
    }
    if (!isTurivaCode(i.voucherCode) && i.turivaRelationCode !== null) {
        return reject("turivaRelationCode", "la relación TurIVA sólo corresponde a comprobantes 195, 196 y 197");
    }

    const { issuer, receiver } = parties(i.direction, i.clientCondition, i.counterpartyCondition);
    if (isTurivaCode(i.voucherCode)) return checkTuriva(i, issuer, receiver);

    const candidates = VOUCHER_MATRIX.filter(
        (r) => r.direction === i.direction && inRange(r, i.dateIso) && r.issuers.includes(issuer) && r.receivers.includes(receiver) && r.codes.includes(i.voucherCode),
    );
    const allowed = candidates.find((r) => r.status === "ALLOWED" && r.variants.includes(i.voucherVariant));
    if (allowed) return { ok: true, rowId: allowed.id, partialValidation: false, requiresTurivaSection: false };

    if (candidates.some((r) => r.status === "ALLOWED")) {
        return reject("voucherVariant", "variante no admitida para ese comprobante en esa fecha");
    }
    if (candidates.some((r) => r.status === "PENDING")) {
        return reject("voucherCode", "combinación pendiente de confirmación normativa: no habilitada", true);
    }
    return reject("voucherCode", "tipo de comprobante no admitido para esas condiciones fiscales y fecha");
}

function checkTuriva(i: VoucherCheckInput, issuer: number, receiver: number): VoucherCheck {
    if (i.dateIso < TURIVA_T_START) return reject("date", "los comprobantes clase T se admiten desde el 01/04/2017");
    if (i.turivaRelationCode === null) return reject("turivaRelationCode", "relación TurIVA requerida para comprobantes 195, 196 y 197");
    if (!TURIVA_RELATIONS.some((r) => r.code === i.turivaRelationCode)) {
        return reject("turivaRelationCode", "relación TurIVA inválida (0001 a 0006)");
    }
    const match = TURIVA_MATRIX.find(
        (t) => t.direction === i.direction && t.issuers.includes(issuer) && t.receivers.includes(receiver) && t.relations.includes(i.turivaRelationCode as string),
    );
    if (!match) return reject("turivaRelationCode", "relación TurIVA incompatible con las condiciones fiscales del emisor y del receptor");

    // Documento del receptor (F.8089 4.2 campos 7 y 9).
    const doc = i.counterpartyDocType;
    const receiverIsCounterparty = i.direction === "SALES";
    if (receiverIsCounterparty) {
        if (doc === null || !(TURIVA_RECEIVER_DOC_TYPES as readonly number[]).includes(doc)) {
            return reject("counterpartyDocType", "documento del receptor inválido para TurIVA (80, 91, 94 o 96)");
        }
        if (receiver === 1 && doc !== DOC_TYPE_CUIT) return reject("counterpartyDocType", "un receptor Responsable Inscripto se identifica con CUIT (80)");
        if (receiver === 5 && doc === DOC_TYPE_CUIT) return reject("counterpartyDocType", "un Consumidor Final no residente se identifica con 91, 94 o 96");
    }
    return { ok: true, rowId: match.id, partialValidation: true, requiresTurivaSection: true };
}
