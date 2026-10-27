/**
 * Validación ESTRUCTURAL de un archivo de catálogo (manifiesto + entradas).
 * Pura: el checksum de las entradas se verifica aparte (`checksum.ts`, sólo
 * Node) para no arrastrar `crypto` al navegador.
 */
import { isJurisdictionCode } from "../iibb/jurisdictions";
import { ACTIVITY_DESCRIPTION_MAX } from "../client-profile";
import { CATALOG_REVIEW_LEVELS, validateReview } from "./review";
import { CATALOG_NOMENCLATORS, catalogReferenceLabel, type CatalogEntry, type CatalogFile } from "./types";

/** Máximo de `nomenclatorReference` en la ficha (lib/client-profile): la referencia copiada debe entrar. */
export const SELECTION_REFERENCE_MAX = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,79}$/;
/** Códigos oficiales: dígitos (con ceros iniciales) y, a lo sumo, letras o puntos de algunos nomencladores. */
export const CATALOG_CODE_RE = /^[0-9A-Z][0-9A-Z.]{0,19}$/;
/** Igual al máximo de la ficha: toda descripción oficial elegible debe poder guardarse sin truncar. */
export const CATALOG_DESCRIPTION_MAX = ACTIVITY_DESCRIPTION_MAX;
export const CATALOG_REFERENCE_MAX = 40;

function isIsoDate(v: unknown): v is string {
    if (typeof v !== "string" || !ISO_DATE.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Lista de problemas (vacía = válido). No corta en el primero: sirve de informe de importación. */
export function validateCatalogFile(raw: unknown): string[] {
    const problems: string[] = [];
    if (typeof raw !== "object" || raw === null) return ["el archivo no es un objeto"];
    const { manifest: m, entries } = raw as Partial<CatalogFile>;
    if (typeof m !== "object" || m === null) return ["falta el manifiesto"];

    if (!nonEmpty(m.id) || !ID_RE.test(m.id)) problems.push("id inválido");
    if (!(CATALOG_NOMENCLATORS as readonly string[]).includes(m.nomenclator as string)) problems.push("nomenclador inválido");
    if (m.nomenclator === "PROVINCIAL") {
        if (!isJurisdictionCode(m.jurisdiction)) problems.push("un nomenclador provincial requiere jurisdicción 901–924");
    } else if (m.jurisdiction !== null) {
        problems.push("ARCA y NAES no llevan jurisdicción");
    }
    for (const k of ["name", "organism", "norm", "sourceUrl", "sourceFile", "version"] as const) {
        if (!nonEmpty(m[k])) problems.push(`falta ${k}`);
    }
    if (nonEmpty(m.sourceUrl) && !/^https:\/\//.test(m.sourceUrl)) problems.push("sourceUrl debe ser https");
    for (const k of ["publishedAt", "consultedAt", "validFrom"] as const) {
        if (!isIsoDate(m[k])) problems.push(`${k} debe ser AAAA-MM-DD`);
    }
    if (m.validTo !== null && !isIsoDate(m.validTo)) problems.push("validTo debe ser AAAA-MM-DD o null");
    if (isIsoDate(m.validFrom) && isIsoDate(m.validTo) && m.validTo < m.validFrom) problems.push("validTo anterior a validFrom");
    if (isIsoDate(m.publishedAt) && isIsoDate(m.consultedAt) && m.consultedAt < m.publishedAt) problems.push("consultedAt anterior a publishedAt");
    if (typeof m.sourceSha256 !== "string" || !SHA256.test(m.sourceSha256)) problems.push("sourceSha256 inválido");
    if (typeof m.entriesSha256 !== "string" || !SHA256.test(m.entriesSha256)) problems.push("entriesSha256 inválido");
    if (m.supersedes !== null && (typeof m.supersedes !== "string" || !ID_RE.test(m.supersedes))) problems.push("supersedes inválido");
    if (m.supersedes === m.id) problems.push("una versión no puede reemplazarse a sí misma");

    problems.push(...validateReview(m.review, CATALOG_REVIEW_LEVELS));

    if (!Array.isArray(entries)) return [...problems, "faltan las entradas"];
    if (entries.length === 0) problems.push("el catálogo no tiene entradas");
    if (m.entryCount !== entries.length) problems.push(`entryCount (${m.entryCount}) distinto de la cantidad de entradas (${entries.length})`);
    const seen = new Set<string>();
    entries.forEach((e: Partial<CatalogEntry>, i) => {
        const at = `entrada ${i + 1}`;
        if (typeof e?.code !== "string" || !CATALOG_CODE_RE.test(e.code)) problems.push(`${at}: código inválido (${String(e?.code)})`);
        else if (seen.has(e.code)) problems.push(`${at}: código duplicado ${e.code}`);
        else seen.add(e.code);
        if (!nonEmpty(e?.description) || e.description.length > CATALOG_DESCRIPTION_MAX) problems.push(`${at}: descripción inválida`);
        else if (e.description !== e.description.trim().replace(/\s+/g, " ")) problems.push(`${at}: descripción sin normalizar`);
        const ef = e?.validFrom ?? null;
        const et = e?.validTo ?? null;
        if (ef !== null && !isIsoDate(ef)) problems.push(`${at}: validFrom debe ser AAAA-MM-DD o null`);
        if (et !== null && !isIsoDate(et)) problems.push(`${at}: validTo debe ser AAAA-MM-DD o null`);
        if (isIsoDate(ef) && isIsoDate(et) && et < ef) problems.push(`${at}: validTo anterior a validFrom`);
        if (isIsoDate(ef) && isIsoDate(m.validFrom) && ef < m.validFrom) problems.push(`${at}: vigencia anterior a la de la versión`);
        if (isIsoDate(et) && isIsoDate(m.validTo) && et > m.validTo) problems.push(`${at}: vigencia posterior a la de la versión`);
        if (e?.reference !== null && (!nonEmpty(e?.reference) || e.reference.length > CATALOG_REFERENCE_MAX)) problems.push(`${at}: referencia inválida`);
        else if (nonEmpty(m.norm) && catalogReferenceLabel(m, { reference: e?.reference ?? null }).length > SELECTION_REFERENCE_MAX) {
            problems.push(`${at}: «norma · referencia» supera ${SELECTION_REFERENCE_MAX} caracteres (no entraría en la ficha); usar una norma abreviada`);
        }
    });
    return problems;
}

/** Entrada canónica para el checksum: orden de las entradas y de las claves fijos. */
export function entriesChecksumInput(entries: readonly CatalogEntry[]): string {
    return JSON.stringify(entries.map((e) => [e.code, e.description, e.reference, e.validFrom ?? null, e.validTo ?? null]));
}

/** Vigencia efectiva de una entrada: la de la versión acotada por la propia del código. */
export function entryValidity(m: { validFrom: string; validTo: string | null }, e: Pick<CatalogEntry, "validFrom" | "validTo">): { validFrom: string; validTo: string | null } {
    const from = e.validFrom && e.validFrom > m.validFrom ? e.validFrom : m.validFrom;
    const to = e.validTo && (m.validTo === null || e.validTo < m.validTo) ? e.validTo : m.validTo;
    return { validFrom: from, validTo: to };
}

/** Vigente en `date` (AAAA-MM-DD), con límites inclusivos. */
export function isValidOn(m: { validFrom: string; validTo: string | null }, date: string): boolean {
    return m.validFrom <= date && (m.validTo === null || date <= m.validTo);
}
