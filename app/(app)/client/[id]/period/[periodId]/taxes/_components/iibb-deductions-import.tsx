"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Importación de retenciones, percepciones y recaudaciones bancarias de IIBB
 * informadas por el fisco (e-SICOL y Rentas Ciudad de AGIP; Santa Cruz). El
 * formato se reconoce solo. Vista previa con el estado de cada fila; las que no
 * se importan quedan listadas aparte, con su total excluido. Lo que el fisco no
 * informa se controla contra los comprobantes físicos y se carga a mano.
 */

type Status = "OK" | "DUPLICATE" | "REVIEW" | "ERROR";
interface Row {
    line: number; status: Status; messages: string[]; type: string; date: string | null;
    agentCuit: string | null; agentName: string | null; voucher: string | null; certificateNumber: string | null;
    cbuLast4: string | null; baseAmount: string | null; amount: string | null;
}
interface Preview {
    format: string | null; formatLabel: string | null; jurisdictionCode: string | null; fileErrors: string[];
    counts: Record<Status, number>; importableTotal: string; excludedTotal: string; token: string; rows: Row[];
}

const STATUS_LABEL: Record<Status, string> = { OK: "Se importa", DUPLICATE: "Ya registrada", REVIEW: "Revisar", ERROR: "Error" };
const TYPE_LABEL: Record<string, string> = { "RETENCION IIBB": "Retención", "PERCEPCION IIBB": "Percepción", SIRCREB: "Bancaria" };

async function toBase64(f: File): Promise<string> {
    const u = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(bin);
}

export function IibbDeductionsImport({ periodId }: { periodId: string }) {
    const router = useRouter();
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [done, setDone] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const inFlight = useRef(false);

    async function send(confirm: boolean) {
        if (!file || inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setMessage(null);
        try {
            const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/iibb-import`, {
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
                const notImported = json ? json.rows.filter((r) => r.status !== "OK").length : 0;
                setMessage({ tone: "status", text: `Importadas ${json?.imported ?? 0} deducciones.${notImported > 0 ? ` No se importaron ${notImported}: quedan listadas abajo.` : ""}` });
                setPreview(json);
                setDone(true);
                router.refresh();
            } else { setPreview(json); setDone(false); }
        } catch {
            setMessage({ tone: "alert", text: "No se pudo procesar el archivo." });
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    }

    const pending = preview?.rows.filter((r) => r.status !== "OK") ?? [];
    const importable = done ? [] : (preview?.rows.filter((r) => r.status === "OK") ?? []);
    const table = (rows: Row[], label: string) => (
        <div className="table-wrap" style={{ marginBottom: "var(--spacing-md)" }}>
            <table className="table" aria-label={label}>
                <thead><tr><th>Línea</th><th>Estado</th><th>Tipo</th><th>Fecha</th><th>Agente</th><th>Comprobante / constancia</th><th className="num">Base</th><th className="num">Importe</th><th>Detalle</th></tr></thead>
                <tbody>
                    {rows.map((r) => (
                        <tr key={r.line}>
                            <td>{r.line}</td><td>{STATUS_LABEL[r.status]}</td><td>{TYPE_LABEL[r.type] ?? r.type}</td><td>{r.date ?? "—"}</td>
                            <td>{r.agentName ?? r.agentCuit ?? "—"}</td>
                            <td>{r.voucher ?? r.certificateNumber ?? (r.cbuLast4 ? `CBU …${r.cbuLast4}` : "—")}</td>
                            <td className="num">{r.baseAmount ?? "—"}</td>
                            <td className="num">{r.amount ?? "—"}</td>
                            <td style={{ color: r.status === "OK" ? "var(--secondary)" : "var(--error)" }}>{r.messages.join(" · ")}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

    return (
        <section className="card" aria-labelledby="iibb-import" style={{ marginBottom: "var(--spacing-lg)" }}>
            <h2 id="iibb-import" style={{ fontSize: "1.125rem", fontWeight: 600, marginBottom: "var(--spacing-sm)" }}>Importar deducciones de IIBB informadas por el fisco</h2>
            <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-sm)" }}>
                Archivos tal como se descargan: e-SICOL o Rentas Ciudad (AGIP, CABA) y la descarga de Santa Cruz (retenciones y bancarias).
                El formato y la jurisdicción se reconocen solos. Si subís el mismo dato en los dos formatos de AGIP, no se duplica.
                Lo que el fisco no informa se controla contra los comprobantes físicos y se carga a mano.
            </p>
            <div style={{ display: "flex", gap: "var(--spacing-md)", flexWrap: "wrap", alignItems: "center" }}>
                <input type="file" accept=".txt,.csv,.xls,text/plain,text/csv" disabled={busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setDone(false); setMessage(null); }} aria-label="Archivo de deducciones de IIBB" />
                <button type="button" className="btn btn-secondary" disabled={!file || busy} onClick={() => send(false)}>Vista previa</button>
                {preview && !done && preview.fileErrors.length === 0 && preview.counts.OK > 0 && (
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => send(true)}>Importar {preview.counts.OK} (total ${preview.importableTotal})</button>
                )}
            </div>
            {message && <p role={message.tone} style={{ marginTop: "var(--spacing-sm)", color: message.tone === "alert" ? "var(--error)" : "var(--success)" }}>{message.text}</p>}
            {preview && (
                <div style={{ marginTop: "var(--spacing-md)" }}>
                    {preview.fileErrors.map((e) => <p key={e} role="alert" style={{ color: "var(--error)" }}>{e}</p>)}
                    {preview.formatLabel && <p style={{ fontSize: "0.875rem" }}>Archivo: {preview.formatLabel} · jurisdicción {preview.jurisdictionCode}.</p>}
                    <p style={{ fontSize: "0.875rem", marginBottom: "var(--spacing-sm)" }}>
                        {done ? "Importación confirmada. " : ""}Se importan {preview.counts.OK} (total ${preview.importableTotal}) · No se importan {pending.length} (total ${preview.excludedTotal}):
                        {" "}ya registradas {preview.counts.DUPLICATE}, para revisar {preview.counts.REVIEW}, con error {preview.counts.ERROR}.
                    </p>
                    {importable.length > 0 && table(importable, "Deducciones que se importan")}
                    {pending.length > 0 && (
                        <>
                            <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "var(--spacing-xs)" }}>Pendientes (no se importan)</h3>
                            {table(pending, "Deducciones pendientes")}
                        </>
                    )}
                </div>
            )}
        </section>
    );
}
