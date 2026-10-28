"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { searchActivityCatalog, type PublishedCatalog } from "@/lib/activity-catalog/client";
import { CATALOG_NOMENCLATOR_LABEL, CATALOG_NOMENCLATORS, selectionFromEntry, type CatalogNomenclator, type CatalogSelection } from "@/lib/activity-catalog/types";
import type { CatalogSearchResult } from "@/lib/activity-catalog/search";
import { jurisdictionLabel } from "@/lib/iibb/jurisdictions";

/**
 * Buscador de actividades en catálogos oficiales PUBLICADOS (revisados). Busca
 * por código (string, con ceros iniciales), descripción o referencia. Cada
 * resultado muestra su nomenclador, versión y vigencia: no se mezclan ni se
 * equiparan códigos de nomencladores distintos. Elegir un resultado PROPONE la
 * actividad; nada se guarda hasta guardar el cliente.
 */
export function ActivityCatalogSearch({
    idPrefix,
    catalogs,
    onSelect,
}: {
    idPrefix: string;
    catalogs: PublishedCatalog[];
    onSelect: (s: CatalogSelection & { catalogLabel: string; validOnDate: boolean }) => void;
}) {
    const available = useMemo(() => CATALOG_NOMENCLATORS.filter((n) => catalogs.some((c) => c.nomenclator === n)), [catalogs]);
    const [nomenclator, setNomenclator] = useState<CatalogNomenclator | "">(available[0] ?? "");
    const provincialJurisdictions = useMemo(
        () => [...new Set(catalogs.filter((c) => c.nomenclator === "PROVINCIAL" && c.jurisdiction).map((c) => c.jurisdiction!))].sort(),
        [catalogs],
    );
    const [jurisdiction, setJurisdiction] = useState("");
    const [query, setQuery] = useState("");
    const [historical, setHistorical] = useState(false);
    // Resultado guardado con la CLAVE de la búsqueda que lo pidió: sólo se muestra
    // si coincide con la búsqueda actual (una respuesta vieja nunca se ve).
    const [state, setState] = useState<{ key: string; phase: "loading" | "done" | "error"; results: CatalogSearchResult[]; message: string } | null>(null);
    const seq = useRef(0);
    const q = query.trim();
    const searchable = nomenclator !== "" && q.length >= 2 && !(nomenclator === "PROVINCIAL" && jurisdiction === "");
    const currentKey = JSON.stringify([q, nomenclator, jurisdiction, historical]);
    const view = searchable && state?.key === currentKey ? state : null;

    useEffect(() => {
        if (!searchable) return;
        const ticket = ++seq.current;
        const key = currentKey;
        const timer = setTimeout(async () => {
            setState({ key, phase: "loading", results: [], message: "" });
            const out = await searchActivityCatalog({ q, nomenclator, jurisdiction: nomenclator === "PROVINCIAL" ? jurisdiction : undefined, historical });
            if (ticket !== seq.current) return; // respuesta vieja: se descarta
            setState(out.ok ? { key, phase: "done", results: out.data.results, message: "" } : { key, phase: "error", results: [], message: out.message });
        }, 300);
        return () => clearTimeout(timer);
    }, [searchable, currentKey, q, nomenclator, jurisdiction, historical]);

    if (available.length === 0) {
        return (
            <p role="status" style={{ fontSize: "0.875rem", color: "var(--secondary)" }}>
                Todavía no hay catálogos oficiales publicados (las importaciones quedan pendientes hasta su revisión). Registrá la actividad como carga manual.
            </p>
        );
    }

    const listId = `${idPrefix}-results`;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--spacing-sm)" }}>
                <label>
                    <span style={{ display: "block", fontWeight: 500 }}>Catálogo</span>
                    <select className="input" value={nomenclator} onChange={(e) => setNomenclator(e.target.value as CatalogNomenclator)}>
                        {available.map((n) => (
                            <option key={n} value={n}>{CATALOG_NOMENCLATOR_LABEL[n]}</option>
                        ))}
                    </select>
                </label>
                {nomenclator === "PROVINCIAL" && (
                    <label>
                        <span style={{ display: "block", fontWeight: 500 }}>Jurisdicción del nomenclador</span>
                        <select className="input" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
                            <option value="">Seleccionar</option>
                            {provincialJurisdictions.map((j) => (
                                <option key={j} value={j}>{jurisdictionLabel(j)}</option>
                            ))}
                        </select>
                    </label>
                )}
                <label>
                    <span style={{ display: "block", fontWeight: 500 }}>Buscar por código, descripción o referencia</span>
                    <input
                        className="input"
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        aria-controls={listId}
                        placeholder="Ej. 620100 o consultoría informática"
                    />
                </label>
            </div>
            <label style={{ display: "flex", gap: "var(--spacing-xs)", alignItems: "center", fontSize: "0.875rem" }}>
                <input type="checkbox" checked={historical} onChange={(e) => setHistorical(e.target.checked)} />
                Incluir versiones revisadas no vigentes hoy (registro histórico)
            </label>
            <p role="status" aria-live="polite" style={{ fontSize: "0.875rem", color: view?.phase === "error" ? "var(--error)" : "var(--secondary)" }}>
                {!searchable && q.length > 0 && q.length < 2 && "Ingresá al menos 2 caracteres."}
                {view?.phase === "loading" && "Buscando..."}
                {view?.phase === "error" && `Error: ${view.message}`}
                {view?.phase === "done" && (view.results.length === 0 ? "Sin resultados en el catálogo elegido." : `${view.results.length} resultado(s).`)}
            </p>
            {view && view.results.length > 0 && (
                <ul id={listId} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", maxHeight: "260px", overflowY: "auto" }}>
                    {view.results.map((r) => {
                        const c = catalogs.find((x) => x.id === r.catalogId);
                        return (
                            <li key={`${r.catalogId}|${r.entry.code}`}>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ width: "100%", textAlign: "left", whiteSpace: "normal" }}
                                    onClick={() =>
                                        c &&
                                        onSelect({
                                            ...selectionFromEntry(c, r.entry),
                                            catalogLabel: r.catalogLabel,
                                            validOnDate: r.validOnDate,
                                        })
                                    }
                                >
                                    <strong>{r.entry.code}</strong> — {r.entry.description}
                                    <span style={{ display: "block", fontSize: "0.8rem", color: "var(--secondary)" }}>
                                        {r.catalogLabel}
                                        {r.entry.reference ? ` · ${r.entry.reference}` : ""}
                                        {r.validOnDate ? " · vigente" : ` · NO vigente hoy (${r.validFrom} a ${r.validTo ?? "sin fin"})`}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
