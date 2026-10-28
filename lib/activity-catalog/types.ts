/**
 * Catálogos oficiales de actividades (datos públicos versionados en el repo).
 *
 * Cada versión es un archivo `data/activity-catalogs/<id>.json` con su
 * manifiesto (organismo, norma, fuente, fechas, vigencia, checksums y estado de
 * revisión) y sus entradas. Una versión nueva se agrega como archivo nuevo:
 * nunca se sobrescribe una anterior ni se modifican clientes.
 *
 * Sin `server-only`: lógica y tipos puros, aptos para cliente y servidor.
 */

/** Nomencladores con catálogo. "OTRO" queda sólo para carga manual. */
export const CATALOG_NOMENCLATORS = ["ARCA", "NAES", "PROVINCIAL"] as const;
export type CatalogNomenclator = (typeof CATALOG_NOMENCLATORS)[number];

export const CATALOG_NOMENCLATOR_LABEL: Readonly<Record<CatalogNomenclator, string>> = {
    ARCA: "ARCA / CLAE (F.883)",
    NAES: "NAES (Comisión Arbitral)",
    PROVINCIAL: "Nomenclador provincial",
};

/**
 * Estado de revisión POR NIVELES (ver `review.ts`). Sólo una versión aprobada
 * con todos sus niveles CONFORME se ofrece en el buscador: una importación nueva
 * queda `PENDIENTE_REVISION` hasta que el estudio la revisa.
 */
export { REVIEW_STATUSES, type ReviewInfo, type ReviewStatus } from "./review";
import type { ReviewInfo } from "./review";

export interface CatalogManifest {
    /** Identificador estable de la versión, p. ej. "naes-rg-ca-19-2025". */
    id: string;
    nomenclator: CatalogNomenclator;
    /** Jurisdicción (código CM 901–924) del nomenclador provincial; null en ARCA/NAES. */
    jurisdiction: string | null;
    /** Nombre del nomenclador concreto (distingue nomencladores provinciales). */
    name: string;
    organism: string;
    norm: string;
    sourceUrl: string;
    sourceFile: string;
    /** Fecha de publicación oficial (AAAA-MM-DD). */
    publishedAt: string;
    /** Fecha en que se consultó/descargó la fuente (AAAA-MM-DD). */
    consultedAt: string;
    /** Versión según el organismo (no se inventan ediciones anuales). */
    version: string;
    validFrom: string;
    /** null = sin fecha de fin conocida. */
    validTo: string | null;
    /** sha256 del archivo oficial tal como se descargó. */
    sourceSha256: string;
    /** sha256 de las entradas normalizadas (ver `entriesChecksumInput`). */
    entriesSha256: string;
    entryCount: number;
    /** Versión anterior a la que reemplaza, si corresponde (no la borra). */
    supersedes: string | null;
    review: ReviewInfo;
}

export interface CatalogEntry {
    /** Código como string: conserva ceros iniciales. */
    code: string;
    description: string;
    /** Referencia oficial adicional (p. ej. sección o código de equivalencia publicado). */
    reference: string | null;
    /**
     * Vigencia propia del código dentro de la versión, cuando la fuente la
     * publica (p. ej. el anexo I de la RG CA 19/2025 trae «Inicio/Fin de
     * Vigencia» por código). Ausente o null = la del manifiesto.
     */
    validFrom?: string | null;
    validTo?: string | null;
}

export interface CatalogFile {
    manifest: CatalogManifest;
    entries: CatalogEntry[];
}

/** Lo que la ficha guarda al elegir una entrada: copia fija, no un puntero vivo. */
export interface CatalogSelection {
    catalogId: string;
    nomenclator: CatalogNomenclator;
    nomenclatorJurisdiction: string;
    catalogVersion: string;
    code: string;
    description: string;
    reference: string;
}

/** Texto de referencia que se muestra y guarda para una selección de catálogo. */
export function catalogReferenceLabel(m: Pick<CatalogManifest, "norm">, entry: Pick<CatalogEntry, "reference">): string {
    return entry.reference ? `${m.norm} · ${entry.reference}` : m.norm;
}

export function selectionFromEntry(m: Pick<CatalogManifest, "id" | "nomenclator" | "jurisdiction" | "version" | "norm">, entry: CatalogEntry): CatalogSelection {
    return {
        catalogId: m.id,
        nomenclator: m.nomenclator,
        nomenclatorJurisdiction: m.nomenclator === "PROVINCIAL" ? (m.jurisdiction ?? "") : "",
        catalogVersion: m.version,
        code: entry.code,
        description: entry.description,
        reference: catalogReferenceLabel(m, entry),
    };
}
