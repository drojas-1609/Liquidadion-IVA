"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readApiError } from "@/lib/new-client-submit";

/**
 * Importación del Libro IVA Digital: el operador elige el libro (ventas o
 * compras) y los DOS archivos TXT del mismo período (comprobantes y alícuotas),
 * revisa la vista previa (estado por fila y conciliación) y confirma. La API es
 * la autoridad: acá no se valida ni se calcula nada fiscal.
 */

type Category = "SALES" | "PURCHASES";
type Format = "LID_TXT" | "PORTAL_CSV";
type Totals = Record<string, string | number>;
interface PreviewRow {
    line: number;
    aliquotLines: number[];
    status: "OK" | "DUPLICATE" | "REVIEW" | "ERROR";
    messages: string[];
    warnings: string[];
    voucherCode: number | null;
    pointOfSale: number | null;
    number: number | null;
    date: string | null;
    docNumber: string | null;
    name: string | null;
    informedTotal: string | null;
    taxedNet: string | null;
    vat: string | null;
    total: string | null;
}
interface Preview {
    token: string;
    periodOpen: boolean;
    turivaFile: boolean;
    fileErrors: string[];
    rows: PreviewRow[];
    reconciliation: {
        files: Record<string, number>;
        informed: Record<string, string>;
        statusCounts: Record<PreviewRow["status"], number>;
        importable: { GENERAL: Totals; TURIVA: Totals; CONSOLIDATED: Totals };
        byRate: Record<string, { net: string; vat: string }>;
        byVoucherType: { voucherCode: number; label: string; sign: 1 | -1; rows: number; importableRows: number; informedTotal: string; signedTotal: string }[];
        signBridge: { unsignedTotal: string; creditNotesTotal: string; creditNotesCount: number; signedTotal: string };
        notImported: { REVIEW: Totals; DUPLICATE: Totals; ERROR: { count: number; informedTotal: string }; reviewWithoutModel: number };
    };
}

const STATUS_LABEL: Record<PreviewRow["status"], string> = { OK: "Se importa", DUPLICATE: "Ya cargado", REVIEW: "Revisar", ERROR: "Error" };
const OUT_LABELS: [string, string][] = [["count", "Comprobantes"], ["taxedNet", "Neto gravado"], ["vat", "IVA"], ["exempt", "Exento"], ["total", "Total"], ["computableCredit", "Crédito computable"]];
const TOTAL_LABELS: [string, string][] = [
    ["count", "Comprobantes"], ["taxedNet", "Neto gravado"], ["vat", "IVA"], ["netWithoutVatBreakdown", "Neto sin discriminar"],
    ["nonTaxed", "No gravado"], ["exempt", "Exento"], ["vatPerception", "Percepciones IVA"], ["nationalPerception", "Perc. nacionales"],
    ["iibbPerception", "Perc. IIBB"], ["municipalPerception", "Perc. municipales"], ["internalTaxes", "Imp. internos"],
    ["otherTaxes", "Otros tributos"], ["total", "Total"], ["turivaRefund", "Reintegro TurIVA"], ["computableCredit", "Crédito computable"],
];

async function toBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

export function LibroIvaImport({ clientId, periodId, turivaIncluded, prorationMode }: { clientId: string; periodId: string; turivaIncluded: boolean; prorationMode: string }) {
    const router = useRouter();
    const [category, setCategory] = useState<Category>("SALES");
    const [format, setFormat] = useState<Format>("LID_TXT");
    const [vouchers, setVouchers] = useState<File | null>(null);
    const [aliquots, setAliquots] = useState<File | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [acceptPartial, setAcceptPartial] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState<string>("");
    const inFlight = useRef(false);

    async function send(kind: "preview" | "confirm") {
        if (inFlight.current || !vouchers || (format === "LID_TXT" && !aliquots)) return;
        inFlight.current = true;
        setBusy(true);
        setError("");
        try {
            const body: Record<string, unknown> = { clientId, category, format, vouchersFile: await toBase64(vouchers) };
            if (format === "LID_TXT" && aliquots) body.aliquotsFile = await toBase64(aliquots);
            if (kind === "confirm" && preview) Object.assign(body, { token: preview.token, acceptPartial });
            const res = await fetch(`/api/periods/${periodId}/libro-iva-import/${kind}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json: unknown = await res.json().catch(() => null);
            if (!res.ok) {
                setError(readApiError(json)?.message ?? "No se pudo procesar la importación.");
                if (kind === "confirm" && res.status === 409) setPreview(null);
                return;
            }
            if (kind === "preview") {
                setPreview(json as Preview);
                setAcceptPartial(false);
            } else {
                const r = json as { imported: number; turiva: number; duplicates: number; notImported: number };
                setDone(`Importados ${r.imported} comprobantes (${r.turiva} de TurIVA). Omitidos por ya cargados: ${r.duplicates}. No importados (error o revisión): ${r.notImported}.`);
                setPreview(null);
                router.refresh();
            }
        } catch {
            setError("Ocurrió un error inesperado. Intentá de nuevo.");
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    }

    const counts = preview?.reconciliation.statusCounts;
    const partial = counts ? counts.ERROR + counts.REVIEW > 0 : false;
    const canConfirm = !!preview && preview.periodOpen && preview.fileErrors.length === 0 && (counts?.OK ?? 0) > 0 && (!partial || acceptPartial);

    return (
        <div>
            <div className="card" style={{ marginBottom: "var(--spacing-lg)" }}>
                <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-sm)" }}>
                    {format === "LID_TXT"
                        ? <>Archivos TXT del Libro IVA Digital (R.G. 4597): el de comprobantes y el de alícuotas del <strong>mismo período y libro</strong>, en ANSI, hasta 2 MB cada uno.</>
                        : <>Descarga de comprobantes del período de Portal IVA: el ZIP <code>comprobantes_periodo_AAAAMM_…</code> tal como se descarga, o el CSV que contiene (montos expresados en pesos), hasta 2 MB.</>}
                    Régimen TurIVA del período: <strong>{turivaIncluded ? "incluido" : "no incluido"}</strong>. Prorrateo del crédito: <strong>{prorationMode}</strong>.
                </p>
                <div style={{ display: "flex", gap: "var(--spacing-md)", flexWrap: "wrap", alignItems: "flex-end" }}>
                    <label>Formato<br />
                        <select value={format} onChange={(e) => { setFormat(e.target.value as Format); setPreview(null); setVouchers(null); setAliquots(null); }} disabled={busy}>
                            <option value="LID_TXT">Libro IVA Digital (par de TXT)</option>
                            <option value="PORTAL_CSV">Descarga de Portal IVA (ZIP o CSV)</option>
                        </select>
                    </label>
                    <label>Libro<br />
                        <select value={category} onChange={(e) => { setCategory(e.target.value as Category); setPreview(null); }} disabled={busy}>
                            <option value="SALES">Ventas</option>
                            <option value="PURCHASES">Compras</option>
                        </select>
                    </label>
                    {format === "LID_TXT" ? (
                        <>
                            <label>Comprobantes (CBTE)<br />
                                <input key="cbte" type="file" accept=".txt,text/plain" disabled={busy} onChange={(e) => { setVouchers(e.target.files?.[0] ?? null); setPreview(null); }} />
                            </label>
                            <label>Alícuotas<br />
                                <input key="ali" type="file" accept=".txt,text/plain" disabled={busy} onChange={(e) => { setAliquots(e.target.files?.[0] ?? null); setPreview(null); }} />
                            </label>
                        </>
                    ) : (
                        <label>Descarga de Portal IVA<br />
                            <input key="portal" type="file" accept=".zip,.csv,application/zip,text/csv" disabled={busy} onChange={(e) => { setVouchers(e.target.files?.[0] ?? null); setPreview(null); }} />
                        </label>
                    )}
                    <button type="button" className="btn btn-primary" disabled={busy || !vouchers || (format === "LID_TXT" && !aliquots)} onClick={() => send("preview")}>
                        {busy ? "Procesando…" : "Vista previa"}
                    </button>
                </div>
            </div>

            {error && <div role="alert" className="card" style={{ border: "1px solid var(--error)", marginBottom: "var(--spacing-md)" }}>{error}</div>}
            {done && <div role="status" className="card" style={{ marginBottom: "var(--spacing-md)" }}>{done}</div>}

            {preview && counts && (
                <div>
                    {preview.fileErrors.length > 0 && (
                        <div role="alert" className="card" style={{ border: "1px solid var(--error)", marginBottom: "var(--spacing-md)" }}>
                            <strong>No se puede confirmar:</strong>
                            <ul>{preview.fileErrors.map((e) => <li key={e}>{e}</li>)}</ul>
                        </div>
                    )}
                    <div className="card" style={{ marginBottom: "var(--spacing-md)" }}>
                        <h2 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-sm)" }}>Conciliación {preview.turivaFile ? "(archivo TurIVA)" : ""}</h2>
                        <p>
                            Registros: {preview.reconciliation.files.voucherRecords} comprobantes, {preview.reconciliation.files.aliquotRecords} alícuotas.
                            Se importan {counts.OK} · ya cargados {counts.DUPLICATE} · revisar {counts.REVIEW} · error {counts.ERROR}.
                        </p>
                        <p style={{ color: "var(--secondary)" }}>
                            Sumas del archivo, de todas las filas leídas y <strong>sin signo</strong> (las notas de crédito suman): total {preview.reconciliation.informed.voucherTotal} · neto de alícuotas {preview.reconciliation.informed.aliquotNet} · IVA de alícuotas {preview.reconciliation.informed.aliquotVat}.
                        </p>
                        <table className="table" style={{ marginBottom: "var(--spacing-sm)" }}>
                            <thead><tr><th>Tipo de comprobante</th><th>Signo</th><th>Filas</th><th>Se importan</th><th>Total del archivo (sin signo)</th><th>Total que se importa (con signo)</th></tr></thead>
                            <tbody>
                                {preview.reconciliation.byVoucherType.map((t) => (
                                    <tr key={t.voucherCode}>
                                        <td>{String(t.voucherCode).padStart(3, "0")} {t.label}</td><td>{t.sign === 1 ? "suma" : "resta"}</td><td>{t.rows}</td><td>{t.importableRows}</td><td>{t.informedTotal}</td><td>{t.signedTotal}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <p data-sign-bridge>
                            Total que se importa sin signo {preview.reconciliation.signBridge.unsignedTotal} − 2 × notas de crédito {preview.reconciliation.signBridge.creditNotesTotal} ({preview.reconciliation.signBridge.creditNotesCount}) = total con signo {preview.reconciliation.signBridge.signedTotal}.
                        </p>
                        <table className="table">
                            <thead><tr><th>Lo que se importa (con signo)</th><th>General</th><th>TurIVA</th><th>Consolidado</th></tr></thead>
                            <tbody>
                                {TOTAL_LABELS.map(([k, label]) => (
                                    <tr key={k}><td>{label}</td><td>{preview.reconciliation.importable.GENERAL[k]}</td><td>{preview.reconciliation.importable.TURIVA[k]}</td><td>{preview.reconciliation.importable.CONSOLIDATED[k]}</td></tr>
                                ))}
                            </tbody>
                        </table>
                        <h3 style={{ fontSize: "1.1rem", margin: "var(--spacing-md) 0 var(--spacing-sm)" }}>Lo que queda afuera (no se importa)</h3>
                        <table className="table" data-not-imported>
                            <thead><tr><th>Con signo</th><th>Para revisar</th><th>Ya cargados</th></tr></thead>
                            <tbody>
                                {OUT_LABELS.map(([k, label]) => (
                                    <tr key={k}><td>{label}</td><td>{preview.reconciliation.notImported.REVIEW[k]}</td><td>{preview.reconciliation.notImported.DUPLICATE[k]}</td></tr>
                                ))}
                            </tbody>
                        </table>
                        {preview.reconciliation.notImported.ERROR.count > 0 && (
                            <p>Con error: {preview.reconciliation.notImported.ERROR.count} filas, total del archivo {preview.reconciliation.notImported.ERROR.informedTotal} (sin importes calculables).</p>
                        )}
                        {preview.reconciliation.notImported.reviewWithoutModel > 0 && (
                            <p>{preview.reconciliation.notImported.reviewWithoutModel} filas para revisar no tienen importes calculables (por ejemplo, tipo de comprobante no admitido).</p>
                        )}
                    </div>
                    <div className="card" style={{ marginBottom: "var(--spacing-md)", overflowX: "auto" }}>
                        <table className="table">
                            <thead><tr><th>Línea</th><th>Estado</th><th>Comprobante</th><th>Fecha</th><th>Documento</th><th>Denominación</th><th>Total archivo</th><th>Neto</th><th>IVA</th><th>Detalle</th></tr></thead>
                            <tbody>
                                {preview.rows.map((r) => (
                                    <tr key={r.line} data-status={r.status}>
                                        <td>{r.line}{r.aliquotLines.length > 0 ? ` (alíc. ${r.aliquotLines.join(", ")})` : ""}</td>
                                        <td>{STATUS_LABEL[r.status]}</td>
                                        <td>{r.voucherCode ?? "—"} {r.pointOfSale ?? ""}-{r.number ?? ""}</td>
                                        <td>{r.date ?? "—"}</td>
                                        <td>{r.docNumber ?? "—"}</td>
                                        <td>{r.name ?? "—"}</td>
                                        <td>{r.informedTotal ?? "—"}</td>
                                        <td>{r.taxedNet ?? "—"}</td>
                                        <td>{r.vat ?? "—"}</td>
                                        <td>{[...r.messages, ...r.warnings].join(" · ")}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {!preview.periodOpen && <p role="alert">El período está cerrado: no se puede confirmar.</p>}
                    <p data-confirm-summary style={{ marginBottom: "var(--spacing-sm)" }}>
                        Se importan <strong>{preview.reconciliation.importable.CONSOLIDATED.count}</strong> comprobantes con IVA <strong>{preview.reconciliation.importable.CONSOLIDATED.vat}</strong>
                        {counts.REVIEW > 0 && <>; quedan para revisar <strong>{counts.REVIEW}</strong> con IVA <strong>{preview.reconciliation.notImported.REVIEW.vat}</strong></>}
                        {counts.ERROR > 0 && <>; con error <strong>{counts.ERROR}</strong></>}.
                    </p>
                    {partial && (
                        <label style={{ display: "block", marginBottom: "var(--spacing-sm)" }}>
                            <input type="checkbox" checked={acceptPartial} onChange={(e) => setAcceptPartial(e.target.checked)} /> Importar sólo las {counts.OK} filas «Se importa»; las de «Revisar» y «Error» quedan fuera.
                        </label>
                    )}
                    <button type="button" className="btn btn-primary" disabled={busy || !canConfirm} onClick={() => send("confirm")}>
                        Confirmar importación
                    </button>
                </div>
            )}
        </div>
    );
}
