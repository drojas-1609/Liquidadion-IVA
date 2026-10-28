/**
 * Catálogos y reglas SINTÉTICOS sólo para tests. NO son datos oficiales: los
 * códigos, descripciones, normas y tasas son inventados para ejercitar la
 * lógica (búsqueda, versiones, vigencias, condiciones). Nunca se registran en
 * la aplicación.
 */
import { entriesSha256 } from "@/lib/activity-catalog/checksum";
import { CATALOG_REVIEW_LEVELS, RULES_REVIEW_LEVELS, pendingReview, type ReviewInfo } from "@/lib/activity-catalog/review";
import type { CatalogEntry, CatalogFile, CatalogManifest } from "@/lib/activity-catalog/types";
import type { RateRule, RateRuleSet, RateRuleSetManifest } from "@/lib/iibb-rates/types";

const SHA = "a".repeat(64);
const conforme = { status: "CONFORME" as const, reviewedBy: "Revisión de prueba", reviewedAt: "2026-01-02", notes: null, checks: [] };
/** Aprobado con todos los niveles CONFORME (catálogo: técnico y vigencia). */
export const REVIEWED: ReviewInfo = { status: "REVISADO", reviewedBy: "Revisión de prueba", reviewedAt: "2026-01-02", notes: null, levels: { technical: conforme, validity: conforme } };
/** Aprobado con los tres niveles de un conjunto de reglas. */
export const REVIEWED_RULES: ReviewInfo = { ...REVIEWED, levels: { ...REVIEWED.levels, interpretation: conforme } };
export const PENDING: ReviewInfo = pendingReview(CATALOG_REVIEW_LEVELS);
export const PENDING_RULES: ReviewInfo = pendingReview(RULES_REVIEW_LEVELS);

export function catalog(over: Partial<CatalogManifest>, entries: CatalogEntry[]): CatalogFile {
    const manifest: CatalogManifest = {
        id: "fixture-naes-v1",
        nomenclator: "NAES",
        jurisdiction: null,
        name: "Fixture NAES (no oficial)",
        organism: "Organismo de prueba",
        norm: "Norma de prueba 1/2025",
        sourceUrl: "https://example.test/naes-v1.xlsx",
        sourceFile: "naes-v1.xlsx",
        publishedAt: "2025-01-01",
        consultedAt: "2025-02-01",
        version: "Prueba 1/2025",
        validFrom: "2025-01-01",
        validTo: null,
        sourceSha256: SHA,
        entriesSha256: entriesSha256(entries),
        entryCount: entries.length,
        supersedes: null,
        review: REVIEWED,
        ...over,
    };
    return { manifest: { ...manifest, entriesSha256: over.entriesSha256 ?? entriesSha256(entries), entryCount: over.entryCount ?? entries.length }, entries };
}

export const NAES_ENTRIES: CatalogEntry[] = [
    { code: "011111", description: "Cultivo de arroz de prueba", reference: null },
    { code: "620100", description: "Servicios de consultoría informática de prueba", reference: "Sección J" },
    { code: "620900", description: "Otros servicios informáticos N.C.P. de prueba", reference: "Sección J" },
    { code: "479101", description: "Venta al por menor por internet de prueba", reference: "Sección G" },
];

/** NAES v1 vigente hasta fin de mayo; v2 desde junio (cambio dentro del año). */
export const NAES_V1 = catalog({ id: "fixture-naes-v1", validFrom: "2025-01-01", validTo: "2026-05-31" }, NAES_ENTRIES);
export const NAES_V2 = catalog(
    { id: "fixture-naes-v2", version: "Prueba 2/2026", norm: "Norma de prueba 2/2026", validFrom: "2026-06-01", validTo: null, supersedes: "fixture-naes-v1" },
    [...NAES_ENTRIES.filter((e) => e.code !== "620900"), { code: "620901", description: "Servicios informáticos nuevos de prueba", reference: "Sección J" }],
);
/** Mismo código 620100 en ARCA/CLAE con OTRA descripción: no son equivalentes. */
export const CLAE = catalog(
    { id: "fixture-clae", nomenclator: "ARCA", name: "Fixture CLAE (no oficial)", version: "CLAE prueba", norm: "RG de prueba" },
    [
        { code: "620100", description: "Servicios de consultores en informática (CLAE de prueba)", reference: null },
        { code: "011111", description: "Cultivo de arroz (CLAE de prueba)", reference: null },
    ],
);
export const PROV_921 = catalog(
    { id: "fixture-prov-921", nomenclator: "PROVINCIAL", jurisdiction: "921", name: "Nomenclador provincial de prueba 921", version: "P-921 v1", norm: "Res. de prueba 921" },
    [{ code: "620100", description: "Informática provincial de prueba", reference: null }],
);
export const NAES_PENDING = catalog({ id: "fixture-naes-pending", review: PENDING, version: "Pendiente" }, [{ code: "999999", description: "Pendiente de revisión", reference: null }]);

// ── Reglas de alícuotas sintéticas ─────────────────────────────────────────

export function ruleSet(over: Partial<RateRuleSetManifest>, rules: RateRule[]): RateRuleSet {
    return {
        manifest: {
            id: "fixture-rules-901",
            jurisdiction: "901",
            nomenclator: "NAES",
            catalogIds: ["fixture-naes-v1", "fixture-naes-v2"],
            organism: "Organismo de prueba",
            norm: "Ley de prueba 2026",
            sourceUrl: "https://example.test/ley-2026.pdf",
            publishedAt: "2025-12-01",
            consultedAt: "2026-01-05",
            version: "2026",
            validFrom: "2026-01-01",
            validTo: "2026-12-31",
            sourceSha256: SHA,
            review: REVIEWED_RULES,
            ...over,
        },
        rules,
    };
}

export const rule = (over: Partial<RateRule>): RateRule => ({
    id: "r1",
    activityCodes: ["620100"],
    registrations: [],
    validFrom: null,
    validTo: null,
    treatment: "RATE",
    rate: "3",
    conditions: [],
    legalReference: "Art. de prueba 1",
    ...over,
});

/** Umbral por ingresos del ejercicio anterior (dos alternativas excluyentes). */
export const THRESHOLD_RULES = [
    rule({
        id: "t-bajo",
        activityCodes: ["479101"],
        rate: "3",
        conditions: [{ kind: "PRIOR_YEAR_GROSS_INCOME", minExclusive: null, maxInclusive: "100000000", description: "Ingresos del año anterior hasta $100.000.000" }],
    }),
    rule({
        id: "t-alto",
        activityCodes: ["479101"],
        rate: "5",
        conditions: [{ kind: "PRIOR_YEAR_GROSS_INCOME", minExclusive: "100000000", maxInclusive: null, description: "Ingresos del año anterior mayores a $100.000.000" }],
    }),
];
