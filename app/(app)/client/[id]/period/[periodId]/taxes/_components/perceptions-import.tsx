"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Importación de percepciones de IVA desde la descarga de ARCA
 * (`Percepciones-impositivas-AAAAMM.csv`). Vista previa con el estado de cada
 * fila y confirmación explícita; la API vuelve a calcular todo bajo el bloqueo
 * del período y rechaza si cambió algo desde la vista previa.
 */

interface Row { line: number; status: "OK" | "DUPLICATE" | "REVIEW" | "ERROR"; messages: string[]; regimeCode: number | null; date: string | null; voucherTypeCode: number | null; voucherNumber: string | null; amount: string | null }
interface Preview { fileErrors: string[]; counts: Record<Row["status"], number>; importableTotal: string; token: string; rows: Row[] }

const STATUS_LABEL: Record<Row["status"], string> = { OK: "Se importa", DUPLICATE: "Ya registrada", REVIEW: "Revisar", ERROR: "Error" };

async function toBase64(f: File): Promise<string> {
    const u = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(bin);
}

export function PerceptionsImport({ periodId }: { periodId: string }) {
    const router = useRouter();
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const inFlight = useRef(false);

    async function send(confirm: boolean) {
        if (!file || inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setMessage(null);
        try {
            const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/perceptions-import`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ file: await toBase64(file), confirm, ...(confirm ? { token: preview?.token } : {}) }),
            });
            const json = (await res.json().catch(() => null)) as (Preview & { imported?: number; error?: { message?: string } }) | null;
            if (!res.ok) {
                setMessage({ tone: "alert", text: typeof json?.error?.message === "string" ? json.error.message : "No se pudo procesar el archivo." });
                return;
            }
            if (confirm) {
                setMessage({ tone: "status", text: `Importadas ${json?.imported ?? 0} percepciones.` });
                setPreview(null);
                setFile(null);
                router.refresh();
            } else setPreview(json);
        } catch {
            setMessage({ tone: "alert", text: "No se pudo procesar el archivo." });
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    }

    return (
        <section className="card" aria-labelledby="perc-import" style={{ marginBottom: "var(--spacing-lg)" }}>
            <h2 id="perc-import" style={{ fontSize: "1.125rem", fontWeight: 600, marginBottom: "var(--spacing-sm)" }}>Importar percepciones de IVA (descarga de ARCA)</h2>
            <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-sm)" }}>
                Archivo <code>Percepciones-impositivas-AAAAMM.csv</code> tal como se descarga. Sólo se importan las percepciones con fecha dentro del período;
                las ya registradas se omiten. Para vincular una percepción a la compra que la informa, cargala desde «Nueva retención/percepción».
            </p>
            <div style={{ display: "flex", gap: "var(--spacing-md)", flexWrap: "wrap", alignItems: "center" }}>
                <input type="file" accept=".csv,text/csv,text/plain" disabled={busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} aria-label="Archivo de percepciones" />
                <button type="button" className="btn btn-secondary" disabled={!file || busy} onClick={() => send(false)}>Vista previa</button>
                {preview && preview.fileErrors.length === 0 && preview.counts.OK > 0 && (
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => send(true)}>Importar {preview.counts.OK} (total ${preview.importableTotal})</button>
                )}
            </div>
            {message && <p role={message.tone} style={{ marginTop: "var(--spacing-sm)", color: message.tone === "alert" ? "var(--error)" : "var(--success)" }}>{message.text}</p>}
            {preview && (
                <div style={{ marginTop: "var(--spacing-md)" }}>
                    {preview.fileErrors.map((e) => <p key={e} role="alert" style={{ color: "var(--error)" }}>{e}</p>)}
                    <p style={{ fontSize: "0.875rem" }}>Se importan {preview.counts.OK} · Ya registradas {preview.counts.DUPLICATE} · Revisar {preview.counts.REVIEW} · Error {preview.counts.ERROR}</p>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                        <thead><tr><th style={{ textAlign: "left" }}>Línea</th><th style={{ textAlign: "left" }}>Estado</th><th style={{ textAlign: "left" }}>Fecha</th><th style={{ textAlign: "left" }}>Régimen</th><th style={{ textAlign: "left" }}>Comprobante</th><th style={{ textAlign: "right" }}>Importe</th><th style={{ textAlign: "left" }}>Detalle</th></tr></thead>
                        <tbody>
                            {preview.rows.map((r) => (
                                <tr key={r.line} style={{ borderTop: "1px solid var(--border)" }}>
                                    <td>{r.line}</td><td>{STATUS_LABEL[r.status]}</td><td>{r.date ?? "—"}</td><td>{r.regimeCode ?? "—"}</td>
                                    <td>{r.voucherTypeCode ?? "—"} · {r.voucherNumber ?? "—"}</td><td style={{ textAlign: "right" }}>{r.amount ?? "—"}</td>
                                    <td style={{ color: r.status === "OK" ? "var(--secondary)" : "var(--error)" }}>{r.messages.join(" · ")}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
