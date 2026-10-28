/**
 * Llamadas del navegador al buscador de catálogos y a la asistencia de
 * alícuotas. Nunca lanzan: devuelven un resultado con mensaje legible.
 */
import { readApiError } from "../new-client-submit";
import type { CatalogSearchResult } from "./search";
import type { CatalogNomenclator } from "./types";
import type { RateSuggestion } from "../iibb-rates/suggest";

export interface PublishedCatalog {
    id: string;
    nomenclator: CatalogNomenclator;
    jurisdiction: string | null;
    name: string;
    organism: string;
    norm: string;
    version: string;
    sourceUrl: string;
    publishedAt: string;
    consultedAt: string;
    validFrom: string;
    validTo: string | null;
    validToday: boolean;
    entryCount: number;
}

type Outcome<T> = { ok: true; data: T } | { ok: false; message: string };

async function getJson<T>(url: string, init: RequestInit | undefined, fetchImpl: typeof fetch, generic: string): Promise<Outcome<T>> {
    let res: Response;
    try {
        res = await fetchImpl(url, init);
    } catch {
        return { ok: false, message: generic };
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: readApiError(body)?.message ?? generic };
    return body === null ? { ok: false, message: generic } : { ok: true, data: body as T };
}

export function fetchPublishedCatalogs(fetchImpl: typeof fetch = fetch) {
    return getJson<{ date: string; catalogs: PublishedCatalog[] }>("/api/activity-catalogs", undefined, fetchImpl, "No se pudieron cargar los catálogos.");
}

export function searchActivityCatalog(
    params: { q: string; nomenclator: CatalogNomenclator; jurisdiction?: string; historical?: boolean },
    fetchImpl: typeof fetch = fetch,
) {
    const qs = new URLSearchParams({ q: params.q, nomenclator: params.nomenclator });
    if (params.jurisdiction) qs.set("jurisdiction", params.jurisdiction);
    if (params.historical) qs.set("historical", "1");
    return getJson<{ date: string; results: CatalogSearchResult[] }>(`/api/activity-catalogs/search?${qs}`, undefined, fetchImpl, "No se pudo buscar en el catálogo.");
}

export function requestRateSuggestion(
    body: {
        jurisdiction: string;
        nomenclator: string;
        catalogId: string | null;
        code: string;
        registration: string | null;
        /** Fecha de referencia del período a liquidar (AAAA-MM-DD). */
        date: string;
        facts: { priorYearGrossIncome?: string | null; declared?: Record<string, boolean> };
    },
    fetchImpl: typeof fetch = fetch,
) {
    return getJson<{ date: string; suggestion: RateSuggestion }>(
        "/api/iibb-rates/suggest",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        fetchImpl,
        "No se pudo consultar la sugerencia de alícuota.",
    );
}
