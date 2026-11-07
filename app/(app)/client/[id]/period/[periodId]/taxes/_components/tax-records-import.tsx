"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Importación de retenciones (con certificado) o percepciones de IVA desde las
 * descargas de ARCA. Vista previa con el estado de cada fila: las que no se
 * importan (revisar, error, ya registradas) se muestran aparte, con su total
 * excluido. La confirmación es explícita; la API vuelve a calcular todo bajo el
 * bloqueo del período y rechaza si cambió algo desde la vista previa.
 */

type Kind = "RETENTIONS" | "PERCEPTIONS";
type Status = "OK" | "DUPLICATE" | "REVIEW" | "ERROR";
interface Row { line: number; status: Status; messages: string[]; regimeCode: number | null; date: string | null; voucherTypeCode: number | null; voucherNumber: string | null; certificateNumber: string | null; amount: string | null; integerAmount: boolean }
interface Preview { kind: Kind; layout: string | null; fileErrors: string[]; counts: Record<Status, number>; importableTotal: string; excludedTotal: string; token: string; rows: Row[] }

const STATUS_LABEL: Record<Status, string> = { OK: "Se importa", DUPLICATE: "Ya registrada", REVIEW: "Revisar", ERROR: "Error" };
const LAYOUT_LABEL: Record<string, string> = { F2051_DESIGN: "diseño de importación del F.2051 (9 campos)", ARCA_DOWNLOAD: "descarga de ARCA (10 campos)", PERCEPTIONS_DOWNLOAD: "descarga de percepciones de ARCA (8 campos)" };
const KIND_FILE: Record<Kind, string> = { RETENTIONS: "Retenciones-AAAAMM.csv o el archivo de importación del F.2051", PERCEPTIONS: "Percepciones-impositivas-AAAAMM.csv" };

async function toBase64(f: File): Promise<string> {
    const u = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(bin);
}

export function TaxRecordsImport({ periodId }: { periodId: string }) {
    const router = useRouter();
    const [kind, setKind] = useState<Kind>("RETENTIONS");
    const [file, setFile] = useState<File | null>(null);
    const [integerPesos, setIntegerPesos] = useState(false);
    const [preview, setPreview] = useState<Preview | null>(null);
    // Tras confirmar se conserva la respuesta (con las filas no importadas) sin
    // ofrecer importar de nuevo: las pendientes nunca desaparecen en silencio.
    const [done, setDone] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const inFlight = useRef(false);
    const reset = () => { setPreview(null); setDone(false); setMessage(null); };

    async function send(confirm: boolean) {
        if (!file || inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setMessage(null);
        try {
            const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/tax-import`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind, file: await toBase64(file), integerAmountsArePesos: integerPesos, confirm, ...(confirm ? { token: preview?.token } : {}) }),
            });
            const json = (await res.json().catch(() => null)) as (Preview & { imported?: number; error?: { message?: string } }) | null;
            if (!res.ok) {
                setMessage({ tone: "alert", text: typeof json?.error?.message === "string" ? json.error.message : "No se pudo procesar el archivo." });
                return;
            }
            if (confirm) {
                const notImported = json ? json.rows.filter((r) => r.status !== "OK").length : 0;
                setMessage({ tone: "status", text: `Importadas ${json?.imported ?? 0} ${kind === "RETENTIONS" ? "retenciones" : "percepciones"}.${notImported > 0 ? ` No se importaron ${notImported}: quedan listadas abajo como pendientes.` : ""}` });
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
        <table aria-label={label} style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem", marginBottom: "var(--spacing-md)" }}>
            <thead><tr><th style={{ textAlign: "left" }}>Línea</th><th style={{ textAlign: "left" }}>Estado</th><th style={{ textAlign: "left" }}>Fecha</th><th style={{ textAlign: "left" }}>Régimen</th><th style={{ textAlign: "left" }}>Comprobante</th>{kind === "RETENTIONS" && <th style={{ textAlign: "left" }}>Certificado</th>}<th style={{ textAlign: "right" }}>Importe</th><th style={{ textAlign: "left" }}>Detalle</th></tr></thead>
            <tbody>
                {rows.map((r) => (
                    <tr key={r.line} style={{ borderTop: "1px solid var(--border)" }}>
                        <td>{r.line}</td><td>{STATUS_LABEL[r.status]}</td><td>{r.date ?? "—"}</td><td>{r.regimeCode ?? "—"}</td>
                        <td>{r.voucherTypeCode ?? "—"} · {r.voucherNumber ?? "—"}</td>{kind === "RETENTIONS" && <td>{r.certificateNumber ?? "—"}</td>}
                        <td style={{ textAlign: "right" }}>{r.amount ?? "—"}</td>
                        <td style={{ color: r.status === "OK" ? "var(--secondary)" : "var(--error)" }}>{r.messages.join(" · ")}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );

    return (
        <section className="card" aria-labelledby="tax-import" style={{ marginBottom: "var(--spacing-lg)" }}>
            <h2 id="tax-import" style={{ fontSize: "1.125rem", fontWeight: 600, marginBottom: "var(--spacing-sm)" }}>Importar retenciones o percepciones de IVA (ARCA)</h2>
            <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-sm)" }}>
                Archivo <code>{KIND_FILE[kind]}</code> tal como se descarga. Se importan sólo las filas con fecha dentro del período; las ya registradas para el cliente (en cualquier período) se omiten.
                Para vincular una percepción a la compra que la informa, cargala desde «Nueva retención/percepción».
            </p>
            <div style={{ display: "flex", gap: "var(--spacing-md)", flexWrap: "wrap", alignItems: "center" }}>
                <label>Tipo{" "}
                    <select value={kind} disabled={busy} onChange={(e) => { setKind(e.target.value as Kind); setFile(null); reset(); }}>
                        <option value="RETENTIONS">Retenciones con certificado</option>
                        <option value="PERCEPTIONS">Percepciones</option>
                    </select>
                </label>
                <input key={kind} type="file" accept=".csv,text/csv,text/plain" disabled={busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }} aria-label="Archivo a importar" />
                <label style={{ fontSize: "0.875rem" }}>
                    <input type="checkbox" checked={integerPesos} disabled={busy} onChange={(e) => { setIntegerPesos(e.target.checked); reset(); }} />{" "}
                    Confirmo que los importes sin decimales del archivo son pesos enteros
                </label>
                <button type="button" className="btn btn-secondary" disabled={!file || busy} onClick={() => send(false)}>Vista previa</button>
                {preview && !done && preview.fileErrors.length === 0 && preview.counts.OK > 0 && (
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => send(true)}>Importar {preview.counts.OK} (total ${preview.importableTotal})</button>
                )}
            </div>
            {message && <p role={message.tone} style={{ marginTop: "var(--spacing-sm)", color: message.tone === "alert" ? "var(--error)" : "var(--success)" }}>{message.text}</p>}
            {preview && (
                <div style={{ marginTop: "var(--spacing-md)" }}>
                    {preview.fileErrors.map((e) => <p key={e} role="alert" style={{ color: "var(--error)" }}>{e}</p>)}
                    {preview.layout && <p style={{ fontSize: "0.875rem" }}>Forma del archivo: {LAYOUT_LABEL[preview.layout] ?? preview.layout}.</p>}
                    <p style={{ fontSize: "0.875rem", marginBottom: "var(--spacing-sm)" }}>
                        {done ? "Importación confirmada. " : ""}Se importan {preview.counts.OK} (total ${preview.importableTotal}) · No se importan {pending.length} (total ${preview.excludedTotal}, fuera de los totales):
                        {" "}ya registradas {preview.counts.DUPLICATE}, para revisar {preview.counts.REVIEW}, con error {preview.counts.ERROR}.
                    </p>
                    {importable.length > 0 && table(importable, "Filas que se importan")}
                    {pending.length > 0 && (
                        <>
                            <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "var(--spacing-xs)" }}>Pendientes (no se importan)</h3>
                            {table(pending, "Filas pendientes")}
                        </>
                    )}
                </div>
            )}
        </section>
    );
}
