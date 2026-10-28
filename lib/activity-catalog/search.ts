/**
 * Búsqueda en catálogos de actividades: por código (string, con ceros
 * iniciales), descripción o referencia oficial. Tolera mayúsculas, acentos y
 * términos parciales. Cada resultado identifica su catálogo: nunca se mezclan
 * ni se equiparan códigos de nomencladores distintos.
 */
import { CATALOG_REVIEW_LEVELS, isApproved } from "./review";
import { entryValidity, isValidOn } from "./validate";
import { CATALOG_NOMENCLATOR_LABEL, type CatalogEntry, type CatalogFile, type CatalogManifest, type CatalogNomenclator } from "./types";

/** Minúsculas, sin acentos ni diacríticos, espacios colapsados. */
export function normalizeSearchText(s: string): string {
    return s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, " ")
        .trim();
}

export interface CatalogSearchFilters {
    nomenclator?: CatalogNomenclator;
    /** Sólo para PROVINCIAL: jurisdicción del nomenclador. */
    jurisdiction?: string;
    /** Catálogo concreto (versión). */
    catalogId?: string;
    /** Fecha de referencia (AAAA-MM-DD) para elegir versiones vigentes. */
    date: string;
    /** true: incluye versiones y códigos REVISADOS no vigentes en `date` (registro histórico). */
    includeNotValid?: boolean;
    limit?: number;
}

export interface CatalogSearchResult {
    catalogId: string;
    nomenclator: CatalogNomenclator;
    jurisdiction: string | null;
    catalogName: string;
    catalogLabel: string;
    version: string;
    norm: string;
    /** Vigencia efectiva del CÓDIGO (versión acotada por la vigencia propia de la entrada). */
    validFrom: string;
    validTo: string | null;
    validOnDate: boolean;
    entry: CatalogEntry;
    /** 0 = código exacto, 1 = prefijo de código, 2 = palabra inicial, 3 = contiene. */
    rank: number;
}

/** Catálogos que se ofrecen: sólo APROBADOS (todos los niveles CONFORME) y, salvo pedido explícito, vigentes en la fecha. */
export function eligibleCatalogs(catalogs: readonly CatalogFile[], f: CatalogSearchFilters): CatalogFile[] {
    return catalogs.filter(({ manifest: m }) => {
        if (!isApproved(m.review, CATALOG_REVIEW_LEVELS)) return false;
        if (f.catalogId && m.id !== f.catalogId) return false;
        if (f.nomenclator && m.nomenclator !== f.nomenclator) return false;
        if (f.jurisdiction && m.jurisdiction !== f.jurisdiction) return false;
        return f.includeNotValid === true || isValidOn(m, f.date);
    });
}

function labelOf(m: CatalogManifest): string {
    const nom = CATALOG_NOMENCLATOR_LABEL[m.nomenclator];
    return m.nomenclator === "PROVINCIAL" ? `${nom} ${m.jurisdiction} · ${m.name} (${m.version})` : `${nom} · ${m.version}`;
}

function rankEntry(entry: CatalogEntry, rawQuery: string, tokens: string[]): number | null {
    const q = rawQuery.trim();
    const codeQuery = q.replace(/[\s.-]/g, "");
    // Código: se compara como string, conservando ceros iniciales.
    if (/^\d+$/.test(codeQuery)) {
        const code = entry.code.replace(/\./g, "");
        if (code === codeQuery) return 0;
        if (code.startsWith(codeQuery)) return 1;
    }
    const haystack = normalizeSearchText(`${entry.code} ${entry.description} ${entry.reference ?? ""}`);
    if (!tokens.every((t) => haystack.includes(t))) return null;
    const words = haystack.split(" ");
    return tokens.every((t) => words.some((w) => w.startsWith(t))) ? 2 : 3;
}

export function searchCatalogs(catalogs: readonly CatalogFile[], query: string, f: CatalogSearchFilters): CatalogSearchResult[] {
    const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
    if (tokens.length === 0) return [];
    const limit = Math.min(Math.max(f.limit ?? 20, 1), 50);
    const out: CatalogSearchResult[] = [];
    for (const { manifest: m, entries } of eligibleCatalogs(catalogs, f)) {
        for (const entry of entries) {
            const validity = entryValidity(m, entry);
            const validOnDate = isValidOn(validity, f.date);
            if (!validOnDate && f.includeNotValid !== true) continue;
            const rank = rankEntry(entry, query, tokens);
            if (rank === null) continue;
            out.push({
                catalogId: m.id,
                nomenclator: m.nomenclator,
                jurisdiction: m.jurisdiction,
                catalogName: m.name,
                catalogLabel: labelOf(m),
                version: m.version,
                norm: m.norm,
                validFrom: validity.validFrom,
                validTo: validity.validTo,
                validOnDate,
                entry,
                rank,
            });
        }
    }
    out.sort((a, b) => a.rank - b.rank || a.entry.code.localeCompare(b.entry.code) || a.catalogId.localeCompare(b.catalogId));
    return out.slice(0, limit);
}

/** Busca una entrada EXACTA por código en un catálogo concreto (verificación del servidor). */
export function findCatalogEntry(catalogs: readonly CatalogFile[], catalogId: string, code: string): { manifest: CatalogManifest; entry: CatalogEntry } | null {
    const c = catalogs.find((x) => x.manifest.id === catalogId);
    const entry = c?.entries.find((e) => e.code === code);
    return c && entry ? { manifest: c.manifest, entry } : null;
}
