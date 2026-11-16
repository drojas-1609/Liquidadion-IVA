"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "@/lib/format";
import { OPERATION_CODES } from "@/lib/arca/catalogs";

/**
 * Revisión y corrección de las filas pendientes de una descarga de ARCA
 * (ventas o compras). Muestra cada fila con su motivo y deja elegir, siempre
 * por decisión de la persona, las correcciones que admite el importador:
 * aceptar diferencias de redondeo de hasta $ 0,02, asignar el código de
 * operación que la descarga no informa y corregir importes de cabecera de una
 * fila. Con ellas se recalcula la vista previa; nada se incorpora hasta
 * confirmarla.
 */

const CORRECTABLE = [
    ["nonTaxed", "No gravado"], ["exempt", "Exento"], ["vatPerception", "Percepción IVA"], ["iibbPerception", "Percepción IIBB"],
    ["nationalPerception", "Percepciones nacionales"], ["municipalPerception", "Percepciones municipales"],
    ["internalTaxes", "Impuestos internos"], ["otherTaxes", "Otros tributos"],
] as const;
type Field = (typeof CORRECTABLE)[number][0];
type Amounts = Partial<Record<Field, string>>;

export interface Corrections {
    acceptRounding?: boolean;
    exemptSaleOperationCode?: string;
    zeroRateOperationCode?: string;
    lineAmounts?: Record<string, Amounts>;
}

interface PendingRow {
    line: number; status: string; reasons: string[]; messages: string[];
    voucherCode: number | null; pointOfSale: number | null; number: number | null; date: string | null;
    docType: number | null; docNumber: string | null; name: string | null; informedTotal: string | null;
    amounts: Record<Field, string> | null;
}
interface PendingResponse { total: number; truncated: boolean; rows: PendingRow[]; corrections: Corrections | null }

const EXEMPT_SALE = /venta B exenta o no gravada .*falta el código de operación/;
const ZERO_RATE = /neto gravado al 0 %|alícuota 0% sin código de operación/;
const PAGE = 50;
const voucher = (row: PendingRow) => `${String(row.voucherCode ?? 0).padStart(3, "0")} ${String(row.pointOfSale ?? 0).padStart(5, "0")}-${String(row.number ?? 0).padStart(8, "0")}`;
/** Diferencia informada en el motivo de la fila, en centavos (sin redondeo de punto flotante). */
function differenceCents(row: PendingRow): number | null {
    const match = row.messages.map((message) => /\(diferencia (-?\d+)\.(\d{2})\)/.exec(message)).find(Boolean);
    if (!match) return null;
    const cents = Number(match[1].replace("-", "")) * 100 + Number(match[2]);
    return match[1].startsWith("-") ? -cents : cents;
}

export function ArcaPendingCorrections({ url, source, legend, busy, onRevised, onMessage }: {
    url: string; source: "SALES" | "PURCHASES"; legend: boolean; busy: boolean;
    onRevised: (status: unknown) => void; onMessage: (message: string) => void;
}) {
    const [data, setData] = useState<PendingResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [corrections, setCorrections] = useState<Corrections>({});
    const [pages, setPages] = useState<Record<string, number>>({});
    const [editing, setEditing] = useState<number | null>(null);
    const [draft, setDraft] = useState<Amounts>({});

    async function load() {
        setLoading(true);
        onMessage("");
        try {
            const response = await fetch(`${url}/pending?source=${source}&legend=${legend ? "1" : "0"}`, { cache: "no-store" });
            const result = await response.json();
            if (!response.ok) { onMessage(result.error?.message ?? "No se pudieron leer las filas pendientes."); return; }
            setData(result);
            setCorrections(result.corrections ?? {});
        } catch {
            onMessage("No se pudo conectar. Volvé a intentar.");
        } finally {
            setLoading(false);
        }
    }
    // Si cambia la leyenda con la lista abierta, se recalcula.
    useEffect(() => { if (data) void load(); }, [legend]); // eslint-disable-line react-hooks/exhaustive-deps

    const groups = useMemo(() => {
        const map = new Map<string, PendingRow[]>();
        for (const row of data?.rows ?? []) for (const reason of new Set(row.reasons)) map.set(reason, [...(map.get(reason) ?? []), row]);
        return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
    }, [data]);
    const rounding = (data?.rows ?? []).filter((row) => { const cents = differenceCents(row); return cents !== null && Math.abs(cents) <= 2; }).length;
    const exemptRows = (data?.rows ?? []).filter((row) => row.messages.some((message) => EXEMPT_SALE.test(message))).length;
    const zeroRows = (data?.rows ?? []).filter((row) => row.messages.some((message) => ZERO_RATE.test(message))).length;
    const lineCount = Object.keys(corrections.lineAmounts ?? {}).length;
    const codes = OPERATION_CODES.filter((entry) => entry.code !== "0");
    const codeLabel = (entry: (typeof codes)[number]) => `${entry.code} — ${source === "SALES" ? entry.salesLabel : entry.purchasesLabel}`;

    function startEdit(row: PendingRow) {
        setEditing(row.line);
        setDraft({ ...(row.amounts ?? {}), ...(corrections.lineAmounts?.[String(row.line)] ?? {}) });
    }
    function saveEdit(row: PendingRow) {
        const changed: Amounts = {};
        for (const [field] of CORRECTABLE) {
            const value = (draft[field] ?? "").trim().replace(",", ".");
            if (value === "" || value === row.amounts?.[field]) continue;
            if (!/^\d{1,13}(\.\d{1,2})?$/.test(value)) { onMessage("Importe inválido: usá números positivos con hasta dos decimales."); return; }
            changed[field] = value;
        }
        const lineAmounts = { ...(corrections.lineAmounts ?? {}) };
        if (Object.keys(changed).length) lineAmounts[String(row.line)] = changed;
        else delete lineAmounts[String(row.line)];
        setCorrections({ ...corrections, lineAmounts });
        setEditing(null);
        onMessage("");
    }

    async function readTask(): Promise<{ status: unknown; task?: { status: string; updatedAt: string } } | null> {
        const response = await fetch(url, { cache: "no-store" }).catch(() => null);
        if (!response?.ok) return null;
        const status = await response.json() as { tasks: { source: string; status: string; updatedAt: string }[] };
        return { status, task: status.tasks.find((task) => task.source === source) };
    }

    async function revise() {
        setSaving(true);
        onMessage("");
        const before = (await readTask())?.task?.updatedAt;
        const done = (result: unknown) => {
            setData(null);
            onRevised(result);
            onMessage("Vista previa recalculada con las correcciones. Revisala y confirmá para incorporar.");
        };
        try {
            const response = await fetch(`${url}/decision`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source, action: "revise", corrections, ...(source === "SALES" ? { consumerFinalLegend: legend } : {}) }),
            });
            const result = await response.json().catch(() => null);
            if (response.ok && result) { done(result); return; }
            if (result?.error) { onMessage(result.error.message ?? "No se pudo recalcular la vista previa."); return; }
            throw new Error("sin respuesta");
        } catch {
            // Con archivos grandes la respuesta puede no llegar aunque el servidor siga
            // recalculando: se espera a que la fuente cambie en lugar de reintentar.
            onMessage("El recálculo tarda más de lo esperado; esperando el resultado…");
            for (let attempt = 0; attempt < 24; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
                const read = await readTask();
                if (read?.task && read.task.status === "PREVIEW" && read.task.updatedAt !== before) { done(read.status); return; }
            }
            onMessage("No se recibió el resultado del recálculo. Recargá la página para ver el estado antes de volver a intentar.");
        } finally {
            setSaving(false);
        }
    }

    if (!data) {
        return (
            <p>
                <button type="button" className="btn" disabled={busy || loading} onClick={() => void load()}>
                    {loading ? "Leyendo filas pendientes…" : "Revisar y corregir las filas pendientes"}
                </button>
            </p>
        );
    }

    return (
        <section aria-label="Corrección de filas pendientes">
            <h4>Filas pendientes ({data.total})</h4>
            {data.truncated && <p>Se muestran las primeras {data.rows.length}.</p>}
            <fieldset>
                <legend>Correcciones (se aplican sólo si las elegís)</legend>
                {rounding > 0 && (
                    <label>
                        <input type="checkbox" checked={corrections.acceptRounding === true} disabled={saving}
                            onChange={(event) => setCorrections({ ...corrections, acceptRounding: event.target.checked || undefined })} />
                        {` Aceptar las diferencias de redondeo de hasta $ 0,02 (${rounding} filas): se guarda el total calculado y la fila conserva en sus notas el total de ARCA y la diferencia.`}
                    </label>
                )}
                {exemptRows > 0 && (
                    <p>
                        <label>
                            {`Código de operación para las ${exemptRows} ventas B exentas o no gravadas sin código: `}
                            <select value={corrections.exemptSaleOperationCode ?? ""} disabled={saving}
                                onChange={(event) => setCorrections({ ...corrections, exemptSaleOperationCode: event.target.value || undefined })}>
                                <option value="">Sin asignar (siguen pendientes)</option>
                                {codes.map((entry) => <option key={entry.code} value={entry.code}>{codeLabel(entry)}</option>)}
                            </select>
                        </label>
                    </p>
                )}
                {zeroRows > 0 && (
                    <p>
                        <label>
                            {`Código de operación para las ${zeroRows} filas con neto gravado al 0 % sin código: `}
                            <select value={corrections.zeroRateOperationCode ?? ""} disabled={saving}
                                onChange={(event) => setCorrections({ ...corrections, zeroRateOperationCode: event.target.value || undefined })}>
                                <option value="">Sin asignar (siguen pendientes)</option>
                                {codes.map((entry) => <option key={entry.code} value={entry.code}>{codeLabel(entry)}</option>)}
                            </select>
                        </label>
                    </p>
                )}
                <p>Importes corregidos a mano: {lineCount} filas. Corregilos con «Corregir importes» en cada fila, según el comprobante.</p>
                <button type="button" className="btn btn-primary" disabled={busy || saving} onClick={() => void revise()}>
                    {saving ? "Recalculando…" : "Recalcular la vista previa con estas correcciones"}
                </button>
            </fieldset>
            {groups.map(([reason, rows]) => {
                const page = pages[reason] ?? 0;
                return (
                    <details key={reason}>
                        <summary>{reason} — {rows.length} filas</summary>
                        <table className="table">
                            <thead><tr><th>Línea</th><th>Comprobante</th><th>Fecha</th><th>Contraparte</th><th>Total ARCA</th><th>Motivos</th><th /></tr></thead>
                            <tbody>
                                {rows.slice(page * PAGE, (page + 1) * PAGE).map((row) => (
                                    <tr key={`${reason}-${row.line}`}>
                                        <td>{row.line}</td>
                                        <td>{voucher(row)}</td>
                                        <td>{row.date ?? "—"}</td>
                                        <td>{row.name || row.docNumber || "—"}</td>
                                        <td>{row.informedTotal ? `$ ${formatMoney(row.informedTotal)}` : "—"}</td>
                                        <td>{row.messages.join(" · ")}{corrections.lineAmounts?.[String(row.line)] && " · importes corregidos en la app"}</td>
                                        <td>
                                            {row.amounts && editing !== row.line && (
                                                <button type="button" className="btn" disabled={saving} onClick={() => startEdit(row)}>Corregir importes</button>
                                            )}
                                            {editing === row.line && (
                                                <span>
                                                    {CORRECTABLE.map(([field, label]) => (
                                                        <label key={field} style={{ display: "block" }}>
                                                            {label}{" "}
                                                            <input inputMode="decimal" value={draft[field] ?? ""} size={12}
                                                                onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} />
                                                        </label>
                                                    ))}
                                                    <button type="button" className="btn btn-primary" onClick={() => saveEdit(row)}>Guardar</button>{" "}
                                                    <button type="button" className="btn" onClick={() => setEditing(null)}>Cancelar</button>
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {rows.length > PAGE && (
                            <p>
                                <button type="button" className="btn" disabled={page === 0} onClick={() => setPages({ ...pages, [reason]: page - 1 })}>Anterior</button>{" "}
                                Página {page + 1} de {Math.ceil(rows.length / PAGE)}{" "}
                                <button type="button" className="btn" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPages({ ...pages, [reason]: page + 1 })}>Siguiente</button>
                            </p>
                        )}
                    </details>
                );
            })}
        </section>
    );
}
