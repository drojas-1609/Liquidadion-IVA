"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TURIVA_SECTION_ID, runTurivaToggle, submitTurivaSetting } from "@/lib/turiva-setting";

/**
 * Inclusión del período en el Régimen TurIVA. OWNER / ADMIN / ACCOUNTANT
 * (canEdit) la modifican con un checkbox; VIEWER sólo ve el estado en texto.
 * La API vuelve a exigir el rol y decide si puede desactivarse (409 con
 * comprobantes 195–197). Sin cambios optimistas: el checkbox refleja siempre
 * el valor confirmado por la API.
 */
export function TurivaSetting({
    periodId,
    turivaIncluded,
    canEdit,
}: {
    periodId: string;
    turivaIncluded: boolean;
    canEdit: boolean;
}) {
    const router = useRouter();
    const [included, setIncluded] = useState(turivaIncluded);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    // Evita dobles envíos aun antes de que React re-renderice el checkbox deshabilitado.
    const inFlight = useRef(false);

    function handleChange() {
        void runTurivaToggle({
            inFlight,
            current: included,
            submit: (next) => submitTurivaSetting(periodId, next),
            setLoading,
            setError,
            setIncluded,
            setSaved,
            refresh: () => router.refresh(),
        });
    }

    const stateText = included ? "Sí" : "No";

    return (
        <section id={TURIVA_SECTION_ID} className="card" aria-labelledby="turiva-title" aria-busy={loading} style={{ marginTop: "var(--spacing-lg)" }}>
            <h3 id="turiva-title" style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)" }}>Régimen TurIVA</h3>
            <p id="turiva-help" style={{ color: "var(--secondary)", marginBottom: "var(--spacing-md)" }}>
                Habilita la carga de comprobantes clase T (195, 196 y 197) en este período. No se puede desactivar si el período
                tiene comprobantes 195–197.
            </p>

            <p style={{ marginBottom: "var(--spacing-sm)" }}>
                Incluido en el Régimen TurIVA: <strong>{stateText}</strong>
            </p>

            {canEdit && (
                <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
                    <input
                        id="turiva-included"
                        type="checkbox"
                        checked={included}
                        disabled={loading}
                        onChange={handleChange}
                        aria-describedby={error ? "turiva-help turiva-error" : "turiva-help"}
                        aria-invalid={error ? true : undefined}
                    />
                    <label htmlFor="turiva-included">Incluir operaciones TurIVA (comprobantes 195–197)</label>
                    {loading && <span role="status">Guardando...</span>}
                </div>
            )}

            {error && (
                <div id="turiva-error" role="alert" style={{ marginTop: "var(--spacing-sm)", padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" }}>
                    {error}
                </div>
            )}
            {saved && !error && (
                <p role="status" style={{ marginTop: "var(--spacing-sm)", color: "var(--success)" }}>
                    Configuración TurIVA guardada.
                </p>
            )}
        </section>
    );
}
