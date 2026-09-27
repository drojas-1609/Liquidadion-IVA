import { cuitCheckDigit } from "../cuit";
import {
    VOUCHER_TYPES,
    DOCUMENT_TYPES,
    DOC_TYPE_CUIT,
    DOC_TYPE_CI_EXTRANJERA,
    DOC_TYPE_PASAPORTE,
    DOC_TYPE_DNI,
    SOURCE_LID_TABLAS,
    SOURCE_RG_1415,
    SOURCE_TURIVA_F8089,
    type OfficialSource,
    type VoucherTypeEntry,
} from "./catalogs";
import type { Direction } from "./voucher-matrix";

/**
 * Documentos admitidos para la CONTRAPARTE de un comprobante de carga manual
 * (tabla 2B aprobada del PR C).
 *
 * La contraparte es el receptor en VENTAS y el emisor en COMPRAS. Cada fila
 * vincula emisor, receptor (condiciones oficiales de "Tipos de responsables")
 * y clase del comprobante con los documentos respaldados:
 *   - ALLOWED: documentos con fuente oficial;
 *   - PENDING: sin fuente suficiente; la combinación queda BLOQUEADA.
 * Toda combinación sin fila ALLOWED se rechaza.
 *
 * Fuente general: RG 1415, Anexo II, Apartado A (datos de los comprobantes A,
 * B, C y E), punto I) emisor y punto II) comprador, en su texto VIGENTE según
 * la RG 5866/2026. Se aplica a todas las fechas; NO se verificaron las
 * versiones anteriores del Anexo II para comprobantes históricos.
 * Códigos de documento: Tablas del Sistema, "2. Tipo de Documento".
 * TurIVA: régimen informativo F.8089, 4.2 campos 7, 9 y 10 (research-report.md §3.3).
 *
 * Pendientes documentados (fuera de este cambio):
 *   - 87 "C D I": citada por el Anexo II A, II d) 2 y presente en la tabla de
 *     documentos, pero NO incorporada a DOCUMENT_TYPES; se agregará en un
 *     cambio separado.
 *   - 99 "Sin identificar / venta global diaria": sólo corresponde por debajo
 *     del umbral de identificación de consumidores finales; los umbrales
 *     históricos no constan en las fuentes locales.
 *   - Clave fiscal extranjera del importador (Anexo II A, II g) 1.3): no tiene
 *     código propio en la tabla de documentos.
 *
 * El número de documento sólo recibe controles de FORMATO técnico (no son
 * reglas fiscales), salvo el dígito verificador de CUIT/CUIL (lib/cuit).
 *
 * Lógica pura, sin `server-only`: la interfaz sólo filtra con estas reglas; la
 * decisión autoritativa se toma en el servidor.
 */

export type DocumentRuleStatus = "ALLOWED" | "PENDING";
type Letter = VoucherTypeEntry["letter"];

export const DOC_TYPE_CUIL = 86;
export const DOC_TYPE_SIN_IDENTIFICAR = 99;

export interface DocumentRule {
    id: string;
    direction: Direction;
    issuers: readonly number[];
    receivers: readonly number[];
    /** Clases de comprobante alcanzadas; vacío = todas (sólo en filas PENDING). */
    letters: readonly Letter[];
    docTypes: readonly number[];
    status: DocumentRuleStatus;
    /**
     * El documento 80 en esta fila puede ser CUIT País: sólo se exige el
     * formato numérico de 11 dígitos, porque la tabla CUIT País no está
     * disponible para verificarlo.
     */
    cuitPais: boolean;
    /** Validación parcial: hay datos que el sistema no puede verificar. */
    partialValidation: boolean;
    sources: readonly OfficialSource[];
    basis: string;
}

const ANEXO_II = "RG 1415, Anexo II, Apartado A (texto vigente según RG 5866/2026)";
const RS = [6, 13, 16] as const;

type RuleSpec = Omit<DocumentRule, "cuitPais" | "partialValidation"> &
    Partial<Pick<DocumentRule, "cuitPais" | "partialValidation">>;
const rule = (r: RuleSpec): DocumentRule => ({ cuitPais: false, partialValidation: false, ...r });

export const DOCUMENT_RULES: readonly DocumentRule[] = [
    // ── Ventas (contraparte = receptor) ───────────────────────────────────
    rule({ id: "DV1", direction: "SALES", issuers: [1], receivers: [1], letters: ["A", "M"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS], basis: `${ANEXO_II}, II a) 3: CUIT del responsable inscripto` }),
    rule({ id: "DV2", direction: "SALES", issuers: [1], receivers: [1], letters: ["T"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        partialValidation: true, sources: [SOURCE_TURIVA_F8089, SOURCE_LID_TABLAS],
        basis: "F.8089 4.2: receptor responsable inscripto con CUIT que no es CUIT País (no verificable)" }),
    rule({ id: "DV3", direction: "SALES", issuers: [1, 4, 6], receivers: [4, 15], letters: ["B", "C"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS], basis: `${ANEXO_II}, II c) 3: CUIT del sujeto exento o no alcanzado` }),
    rule({ id: "DV4", direction: "SALES", issuers: [1, 4, 6], receivers: RS, letters: ["A", "B", "C", "M"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS], basis: `${ANEXO_II}, II e) 3: CUIT del adherido al Régimen Simplificado` }),
    rule({ id: "DV5", direction: "SALES", issuers: [1, 4, 6], receivers: [7], letters: ["B", "C"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS], basis: `${ANEXO_II}, II f) 3: CUIT del sujeto no categorizado` }),
    rule({ id: "DV6", direction: "SALES", issuers: [1, 4, 6], receivers: [5], letters: ["B", "C"],
        docTypes: [DOC_TYPE_DNI, DOC_TYPE_CUIL, DOC_TYPE_CI_EXTRANJERA, DOC_TYPE_PASAPORTE, DOC_TYPE_CUIT], status: "ALLOWED",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS],
        basis: `${ANEXO_II}, II d) 2 (DNI, CUIL o documento o pasaporte del extranjero) y párrafo final de d) (CUIT si el comprador lo requiere)` }),
    rule({ id: "DV7", direction: "SALES", issuers: [1, 4, 6], receivers: [5], letters: ["B", "C"], docTypes: [DOC_TYPE_SIN_IDENTIFICAR], status: "PENDING",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS],
        basis: `${ANEXO_II}, II d) 2: sólo por debajo del umbral de identificación; umbrales históricos no verificados` }),
    rule({ id: "DV8", direction: "SALES", issuers: [1], receivers: [5], letters: ["T"],
        docTypes: [DOC_TYPE_CI_EXTRANJERA, DOC_TYPE_PASAPORTE, DOC_TYPE_DNI], status: "ALLOWED", partialValidation: true,
        sources: [SOURCE_TURIVA_F8089, SOURCE_LID_TABLAS], basis: "F.8089 4.2 campos 7, 9 y 10: turista no residente con 91, 94 o 96" }),
    rule({ id: "DV9", direction: "SALES", issuers: [1, 4, 6], receivers: [9], letters: ["E"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        cuitPais: true, partialValidation: true, sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS],
        basis: `${ANEXO_II}, II g) 1.3: CUIT o CUIT País (no verificable) del importador` }),
    rule({ id: "DV10", direction: "SALES", issuers: [1, 4, 6], receivers: [9], letters: ["E"], docTypes: [], status: "PENDING",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS],
        basis: `${ANEXO_II}, II g) 1.3: clave fiscal extranjera sin código en la tabla de documentos` }),
    rule({ id: "DV11", direction: "SALES", issuers: [1], receivers: [9], letters: ["T"],
        docTypes: [DOC_TYPE_CI_EXTRANJERA, DOC_TYPE_PASAPORTE, DOC_TYPE_DNI, DOC_TYPE_CUIT], status: "ALLOWED",
        cuitPais: true, partialValidation: true, sources: [SOURCE_TURIVA_F8089, SOURCE_LID_TABLAS],
        basis: "F.8089 4.2 campos 7, 9 y 10: 91, 94, 96 o 80 sólo como CUIT País (no verificable)" }),
    rule({ id: "DV12", direction: "SALES", issuers: [1, 4, 6], receivers: [8, 10], letters: [], docTypes: [], status: "PENDING",
        sources: [], basis: "Condiciones 8 y 10 sin fuente expresa (research-report.md V25)" }),
    rule({ id: "DV13", direction: "SALES", issuers: [4, 6], receivers: [1], letters: ["C"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS],
        basis: `${ANEXO_II}, II a) 3: CUIT del adquirente responsable inscripto (comprobante C emitido por un exento o monotributista)` }),

    // ── Compras (contraparte = emisor) ────────────────────────────────────
    rule({ id: "DC1", direction: "PURCHASES", issuers: [1], receivers: [1, 4, 6], letters: ["A", "B", "M"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS], basis: `${ANEXO_II}, I) a) 3: CUIT del emisor` }),
    rule({ id: "DC2", direction: "PURCHASES", issuers: [1], receivers: [1], letters: ["T"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        partialValidation: true, sources: [SOURCE_RG_1415, SOURCE_TURIVA_F8089, SOURCE_LID_TABLAS],
        basis: `${ANEXO_II}, I) a) 3: CUIT del emisor; comprobante T con validación parcial` }),
    rule({ id: "DC3", direction: "PURCHASES", issuers: [4, 6, 13, 16], receivers: [1, 4, 6], letters: ["C"], docTypes: [DOC_TYPE_CUIT], status: "ALLOWED",
        sources: [SOURCE_RG_1415, SOURCE_LID_TABLAS], basis: `${ANEXO_II}, I) a) 3: CUIT del emisor` }),
    rule({ id: "DC4", direction: "PURCHASES", issuers: [15, 8, 10], receivers: [1, 4, 6], letters: [], docTypes: [], status: "PENDING",
        sources: [], basis: "Emisores 15, 8 y 10 sin fuente expresa (research-report.md C27 y C28)" }),
];

// ── Consultas ─────────────────────────────────────────────────────────────

function parties(direction: Direction, clientCondition: number, counterpartyCondition: number) {
    return direction === "SALES"
        ? { issuer: clientCondition, receiver: counterpartyCondition }
        : { issuer: counterpartyCondition, receiver: clientCondition };
}

function letterOf(voucherCode: number): Letter | null {
    return VOUCHER_TYPES.find((v) => v.code === voucherCode)?.letter ?? null;
}

function rulesFor(direction: Direction, clientCondition: number, counterpartyCondition: number, voucherCode: number): DocumentRule[] {
    const letter = letterOf(voucherCode);
    if (letter === null) return [];
    const { issuer, receiver } = parties(direction, clientCondition, counterpartyCondition);
    return DOCUMENT_RULES.filter(
        (r) =>
            r.direction === direction &&
            r.issuers.includes(issuer) &&
            r.receivers.includes(receiver) &&
            (r.letters.length === 0 || r.letters.includes(letter)),
    );
}

/**
 * ÚNICO mecanismo de coincidencia: filas de un estado aplicables a
 * (direction, condiciones, código). Lo usan allowedDocTypes,
 * allowedDocumentRule, pendingDocumentRules y checkCounterpartyDocument.
 */
function matchingRules(
    direction: Direction,
    clientCondition: number | null,
    counterpartyCondition: number | null,
    voucherCode: number,
    status: DocumentRuleStatus,
): DocumentRule[] {
    if (clientCondition === null || counterpartyCondition === null) return [];
    return rulesFor(direction, clientCondition, counterpartyCondition, voucherCode).filter((r) => r.status === status);
}

/** Metadata normativa de una fila (sin validar ningún número de documento). */
export type DocumentRuleMetadata = Pick<
    DocumentRule,
    "id" | "status" | "docTypes" | "cuitPais" | "partialValidation" | "sources" | "basis"
>;

const metadataOf = (r: DocumentRule): DocumentRuleMetadata => ({
    id: r.id,
    status: r.status,
    docTypes: r.docTypes,
    cuitPais: r.cuitPais,
    partialValidation: r.partialValidation,
    sources: r.sources,
    basis: r.basis,
});

/** Documentos que la interfaz puede ofrecer (sólo filas ALLOWED). */
export function allowedDocTypes(
    direction: Direction,
    clientCondition: number | null,
    counterpartyCondition: number | null,
    voucherCode: number,
): number[] {
    const out = new Set<number>();
    for (const r of matchingRules(direction, clientCondition, counterpartyCondition, voucherCode, "ALLOWED")) {
        r.docTypes.forEach((d) => out.add(d));
    }
    return [...out].sort((a, b) => a - b);
}

/**
 * Fila ALLOWED que admite `docType` para esa operación, o null. Devuelve sólo
 * metadata normativa (incluida `partialValidation` y si el 80 puede ser CUIT
 * País); NO valida el número de documento (eso es checkCounterpartyDocument).
 */
export function allowedDocumentRule(
    direction: Direction,
    clientCondition: number | null,
    counterpartyCondition: number | null,
    voucherCode: number,
    docType: number,
): DocumentRuleMetadata | null {
    const r = matchingRules(direction, clientCondition, counterpartyCondition, voucherCode, "ALLOWED").find((x) =>
        x.docTypes.includes(docType),
    );
    return r ? metadataOf(r) : null;
}

/**
 * Filas PENDING aplicables a esa operación (metadata). `docTypes` vacío = la
 * fila deja pendiente cualquier documento no admitido por una fila ALLOWED.
 */
export function pendingDocumentRules(
    direction: Direction,
    clientCondition: number | null,
    counterpartyCondition: number | null,
    voucherCode: number,
): DocumentRuleMetadata[] {
    return matchingRules(direction, clientCondition, counterpartyCondition, voucherCode, "PENDING").map(metadataOf);
}

export interface CounterpartyDocumentInput {
    direction: Direction;
    clientCondition: number | null;
    counterpartyCondition: number | null;
    voucherCode: number;
    docType: number;
    docNumber: string;
}

export type CounterpartyDocumentField = "counterpartyDocType" | "counterpartyDocNumber";

export type CounterpartyDocumentCheck =
    | { ok: true; ruleId: string; docType: number; docNumber: string; partialValidation: boolean }
    | { ok: false; field: CounterpartyDocumentField; error: string; pending: boolean };

const reject = (field: CounterpartyDocumentField, error: string, pending = false): CounterpartyDocumentCheck => ({
    ok: false,
    field,
    error,
    pending,
});

/** Formato técnico del número. Devuelve el número normalizado o un error. */
function normalizeDocNumber(
    docType: number,
    raw: string,
    cuitPais: boolean,
): { ok: true; value: string } | { ok: false; error: string } {
    const v = raw.trim();
    if (v === "") return { ok: false, error: "número de documento requerido" };
    if (docType === DOC_TYPE_CUIT && cuitPais) {
        // CUIT o CUIT País: formato numérico de 11 dígitos; el país no se verifica.
        return /^\d{11}$/.test(v) ? { ok: true, value: v } : { ok: false, error: "debe tener 11 dígitos numéricos" };
    }
    if (docType === DOC_TYPE_CUIT || docType === DOC_TYPE_CUIL) {
        const digits = v.replace(/[ .-]/g, "");
        if (!/^\d{11}$/.test(digits)) return { ok: false, error: "debe tener 11 dígitos" };
        const expected = cuitCheckDigit(digits.slice(0, 10));
        if (expected === null || expected !== Number(digits[10])) return { ok: false, error: "dígito verificador incorrecto" };
        return { ok: true, value: digits };
    }
    if (docType === DOC_TYPE_DNI) {
        const digits = v.replace(/\./g, "");
        return /^\d{1,20}$/.test(digits) ? { ok: true, value: digits } : { ok: false, error: "el DNI sólo admite dígitos" };
    }
    // 91 y 94: documentos extranjeros, alfanuméricos.
    return /^[A-Za-z0-9]{1,20}$/.test(v) ? { ok: true, value: v.toUpperCase() } : { ok: false, error: "sólo se admiten letras y dígitos" };
}

/**
 * Valida el documento de la contraparte para una NUEVA carga manual.
 * Complementa (no reemplaza) la matriz de comprobantes de voucher-matrix.
 */
export function checkCounterpartyDocument(i: CounterpartyDocumentInput): CounterpartyDocumentCheck {
    if (i.clientCondition === null || i.counterpartyCondition === null) {
        return reject("counterpartyDocType", "condiciones fiscales requeridas para validar el documento");
    }
    if (!DOCUMENT_TYPES.some((d) => d.code === i.docType)) {
        return reject("counterpartyDocType", "tipo de documento fuera del catálogo admitido");
    }
    const allowed = allowedDocumentRule(i.direction, i.clientCondition, i.counterpartyCondition, i.voucherCode, i.docType);
    if (!allowed) {
        const pending = pendingDocumentRules(i.direction, i.clientCondition, i.counterpartyCondition, i.voucherCode).some(
            (r) => r.docTypes.length === 0 || r.docTypes.includes(i.docType),
        );
        return pending
            ? reject("counterpartyDocType", "documento pendiente de confirmación normativa para esta operación: no habilitado", true)
            : reject("counterpartyDocType", "tipo de documento no admitido para esta operación");
    }
    const n = normalizeDocNumber(i.docType, i.docNumber, allowed.cuitPais);
    if (!n.ok) return reject("counterpartyDocNumber", n.error);
    return { ok: true, ruleId: allowed.id, docType: i.docType, docNumber: n.value, partialValidation: allowed.partialValidation };
}
