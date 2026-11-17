"use client";

import { useEffect, useRef, useState } from "react";
import { formatMoney } from "@/lib/format";
import type { SyncPreviewSummary, SyncVariant } from "@/lib/arca-sync/preview";
import { ArcaPendingCorrections } from "./arca-pending-corrections";
import { ArcaInitialDataSection, type InitialDataStatus } from "./arca-initial-data";

const LABELS: Record<string, string> = {
    SALES: "Ventas", PURCHASES: "Compras", RETENTIONS: "Retenciones", PERCEPTIONS: "Percepciones",
    PENDING: "En espera", RUNNING: "Descargando de ARCA", DONE: "Incorporada",
    EMPTY: "Consulta correcta: ARCA no informa datos en el período",
    PREVIEW: "Vista previa lista: falta tu confirmación", CONFIRMING: "Incorporando",
    REVIEW: "Incorporada, con filas para revisar", DISCARDED: "Vista previa descartada: no se incorporó nada",
    AUTH_REQUIRED: "Sesión de ARCA vencida", FAILED: "Falló la descarga",
};

/** Tabla de alícuotas del Libro IVA Digital (código -> porcentaje). */
const RATE_LABELS: Record<string, string> = { "0003": "0 %", "0004": "10,5 %", "0005": "21 %", "0006": "27 %", "0008": "5 %", "0009": "2,5 %" };
const STATUS_LABELS: Record<string, string> = { REVIEW: "Para revisar", ERROR: "Error", DUPLICATE: "Duplicada" };
const money = (value: string) => `$ ${formatMoney(value)}`;

function Variant({ variant }: { variant: SyncVariant }) {
    const { counts, invoices, taxes, reasons } = variant;
    return (
        <div className="stack">
            <div className="stats">
                <div className={`stat ${counts.OK ? "is-success" : "is-muted"}`}><div className="label">Nuevas</div><div className="value">{counts.OK}</div></div>
                <div className="stat is-muted"><div className="label">Ya incorporadas</div><div className="value">{counts.DUPLICATE}</div></div>
                <div className={`stat ${counts.REVIEW ? "is-warning" : "is-muted"}`}><div className="label">Pendientes</div><div className="value">{counts.REVIEW}</div></div>
                <div className={`stat ${counts.ERROR ? "is-error" : "is-muted"}`}><div className="label">Errores</div><div className="value">{counts.ERROR}</div></div>
            </div>
            {invoices && counts.OK > 0 && (
                <div className="table-wrap">
                    <table className="data-table">
                        <thead><tr><th>Filas nuevas (las notas de crédito restan)</th><th className="num">Neto</th><th className="num">IVA</th></tr></thead>
                        <tbody>
                            {invoices.byRate.map((rate) => <tr key={rate.code}><td>{RATE_LABELS[rate.code] ?? `Alícuota ${rate.code}`}</td><td className="num">{money(rate.net)}</td><td className="num">{money(rate.vat)}</td></tr>)}
                            {invoices.importable.nonTaxed !== "0.00" && <tr><td>No gravado</td><td className="num">{money(invoices.importable.nonTaxed)}</td><td /></tr>}
                            {invoices.importable.exempt !== "0.00" && <tr><td>Exento</td><td className="num">{money(invoices.importable.exempt)}</td><td /></tr>}
                            {invoices.importable.otherTaxes !== "0.00" && <tr><td>Otros tributos y percepciones</td><td className="num">{money(invoices.importable.otherTaxes)}</td><td /></tr>}
                            <tr className="total"><th scope="row">Total</th><td className="num">{money(invoices.importable.total)}</td><td className="num">{money(invoices.importable.vat)}</td></tr>
                        </tbody>
                    </table>
                </div>
            )}
            {invoices && (counts.REVIEW > 0 || counts.DUPLICATE > 0 || counts.ERROR > 0) && (
                <p className="muted">
                    Sin incorporar: pendientes {money(invoices.pendingTotal)}
                    {counts.DUPLICATE > 0 && ` · ya incorporadas ${money(invoices.duplicateTotal)}`}
                    {counts.ERROR > 0 && ` · con error ${money(invoices.errorInformedTotal)} (total informado)`}
                </p>
            )}
            {taxes && <p className="muted">Total de filas nuevas: {money(taxes.importableTotal)}{taxes.excludedTotal !== "0.00" && ` · sin incorporar: ${money(taxes.excludedTotal)}`}</p>}
            {reasons.length > 0 && (
                <details>
                    <summary>Filas sin incorporar, por motivo <span className="muted">(una fila puede tener más de uno)</span></summary>
                    <div className="table-wrap">
                        <table className="data-table">
                            <thead><tr><th>Estado</th><th>Motivo</th><th className="num">Filas</th></tr></thead>
                            <tbody>{reasons.map((reason) => (
                                <tr key={`${reason.status}-${reason.message}`}>
                                    <td><span className={`badge ${REASON_BADGE[reason.status] ?? ""}`}>{STATUS_LABELS[reason.status]}</span></td>
                                    <td>{reason.message}</td>
                                    <td className="num">{reason.rows}</td>
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                </details>
            )}
        </div>
    );
}

/** Color de la insignia de cada estado de la corrida. */
const TASK_BADGE: Record<string, string> = {
    PENDING: "", RUNNING: "badge-info", CONFIRMING: "badge-info", PREVIEW: "badge-warning", REVIEW: "badge-warning",
    DONE: "badge-success", EMPTY: "badge-success", DISCARDED: "", AUTH_REQUIRED: "badge-error", FAILED: "badge-error",
};
const SHORT_STATUS: Record<string, string> = {
    PENDING: "En espera", RUNNING: "Descargando", CONFIRMING: "Incorporando", PREVIEW: "Falta confirmar", REVIEW: "Con pendientes",
    DONE: "Incorporada", EMPTY: "Sin datos en ARCA", DISCARDED: "Descartada", AUTH_REQUIRED: "Sesión vencida", FAILED: "Falló",
};
const REASON_BADGE: Record<string, string> = { REVIEW: "badge-warning", ERROR: "badge-error", DUPLICATE: "" };

const ERROR_LABELS: Record<string, string> = {
    REPRESENTATION_REQUIRED: "ARCA no confirmó el CUIT representado. Revisá los permisos del administrador para este servicio.",
    ARCA_SESSION: "Volvé a intentar para renovar la sesión.",
    VERIFICATION_REQUIRED: "ARCA pide una verificación para ingresar.",
    CREDENTIALS_MISSING: "Falta configurar el acceso de este CUIT.",
    ACCESS_REVOKED: "La cuenta que inició la corrida ya no tiene acceso al período.",
    DISPATCH_FAILED: "No se pudo iniciar el proceso de descarga.",
    ARCA_DOWNLOAD: "ARCA no entregó un archivo descargable.",
    ARCA_TIMEOUT_LOGIN: "Se agotó el tiempo al iniciar sesión en ARCA.",
    ARCA_TIMEOUT_SERVICE: "Se agotó el tiempo al abrir el servicio de ARCA.",
    ARCA_TIMEOUT_REPRESENTATION: "Se agotó el tiempo al seleccionar el CUIT representado.",
    ARCA_TIMEOUT_QUERY: "Se agotó el tiempo al consultar el período en ARCA.",
    ARCA_TIMEOUT_EXPORT: "Se agotó el tiempo al descargar el archivo de ARCA.",
    ARCA_FORMAT: "El archivo que entregó ARCA está vacío o supera el tamaño admitido.",
    ARCA_PAGE: "La pantalla de ARCA no tiene los controles esperados. No se descargó ningún archivo.",
    ARCA_PERIOD: "ARCA no confirmó el período pedido. No se descargó ningún archivo.",
    IMPORT_REJECTED: "El importador rechazó el archivo descargado: no coincide con el formato de importación.",
    ARCA_IMPORT: "No se pudo preparar la vista previa. Volvé a intentar.",
    ARCA_DRAFT_OTHER_PERIOD: "IVA Simple tiene abierto un borrador sin presentar de un período anterior. Presentalo o descartalo en ARCA y volvé a intentar.",
    ARCA_INITIAL_DATA_REQUIRED: "IVA Simple pidió los datos iniciales del período y no hay una elección guardada. Confirmalos arriba y volvé a intentar.",
};

type Status = {
    configured: boolean;
    schedule: { enabled: boolean; extraDays: number[] } | null;
    initialData: InitialDataStatus;
    tasks: Array<{
        source: string; status: string; downloaded: number | null; imported: number | null; duplicates: number | null;
        pending: number; errorCode: string | null; updatedAt: string;
        preview: SyncPreviewSummary | null;
        /** El archivo sigue guardado: las filas pendientes se pueden revisar y corregir. */
        correctable: boolean;
        issues: Array<{ file: number; line: number; status: string; messages: string[] }>;
    }>;
};

/** Leyenda elegida para la vista previa de ventas de la corrida actual (no la de corridas anteriores). */
function legendOf(value: Status): boolean {
    const sales = value.tasks.find((task) => task.source === "SALES")?.preview;
    return (sales?.consumerFinalApplied ?? sales?.confirmed?.consumerFinalLegend) === true;
}
const salesKey = (value: Status) => {
    const sales = value.tasks.find((task) => task.source === "SALES");
    return sales ? `${sales.status}|${sales.updatedAt}` : "";
};

export function ArcaSyncPanel({ periodId, canSchedule }: { periodId: string; canSchedule: boolean }) {
    const url = `/api/periods/${encodeURIComponent(periodId)}/arca-sync`;
    const [status, setStatus] = useState<Status>();
    const [enabled, setEnabled] = useState(false);
    const [days, setDays] = useState(["", ""]);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [legend, setLegend] = useState(false);
    const lastSales = useRef("");
    /** Aplica un estado nuevo; la leyenda sólo se resincroniza cuando cambió la fuente de ventas. */
    function apply(value: Status) {
        setStatus(value);
        const key = salesKey(value);
        if (key !== lastSales.current) {
            lastSales.current = key;
            setLegend(legendOf(value));
        }
    }
    async function refresh(): Promise<Status | null> {
        const fresh = await fetch(url, { cache: "no-store" }).catch(() => null);
        if (!fresh?.ok) return null;
        const value: Status = await fresh.json();
        apply(value);
        return value;
    }
    const active = status?.tasks.some((task) => task.status === "PENDING" || task.status === "RUNNING" || task.status === "CONFIRMING") ?? false;
    const awaiting = status?.tasks.some((task) => task.status === "PREVIEW" || task.status === "CONFIRMING") ?? false;
    const retryable = status?.tasks.some((task) => task.status === "FAILED" || task.status === "AUTH_REQUIRED") ?? false;

    useEffect(() => {
        const controller = new AbortController();
        fetch(url, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
            if (!response.ok) throw new Error();
            const value: Status = await response.json();
            apply(value);
            setEnabled(value.schedule?.enabled ?? false);
            setDays([0, 1].map((index) => value.schedule?.extraDays[index]?.toString() ?? ""));
        }).catch(() => { if (!controller.signal.aborted) setMessage("No se pudo consultar la automatización de ARCA."); });
        return () => controller.abort();
    }, [url]);

    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        const timer = setInterval(() => {
            fetch(url, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
                if (response.ok) apply(await response.json());
            }).catch(() => {});
        }, 4000);
        return () => { clearInterval(timer); controller.abort(); };
    }, [active, url]);

    async function submit(method: "POST" | "PUT") {
        setBusy(true);
        setMessage("");
        try {
            const response = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: method === "PUT" ? JSON.stringify({ enabled, extraDays: days.filter(Boolean).map(Number) }) : undefined,
            });
            const result = await response.json();
            if (!response.ok) {
                setMessage(result.error?.message ?? "No se pudo guardar.");
                return;
            }
            apply(result);
            setMessage(method === "PUT" ? "Calendario guardado." : "Importación solicitada.");
        } catch {
            setMessage("No se pudo conectar. Volvé a intentar.");
        } finally {
            setBusy(false);
        }
    }

    async function decide(source: string, action: "confirm" | "discard") {
        setBusy(true);
        setMessage("");
        try {
            const response = await fetch(`${url}/decision`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source, action, ...(source === "SALES" && action === "confirm" ? { consumerFinalLegend: legend } : {}) }),
            });
            const result = await response.json();
            if (!response.ok) {
                setMessage(result.error?.message ?? "No se pudo resolver la vista previa.");
                // La vista previa pudo cambiar: se vuelve a leer antes de decidir otra vez.
                await refresh();
                return;
            }
            apply(result);
            setMessage(action === "confirm" ? `${LABELS[source]}: incorporación confirmada.` : `${LABELS[source]}: vista previa descartada.`);
        } catch {
            // Con archivos grandes la respuesta puede no llegar aunque el servidor haya terminado:
            // se relee el estado en lugar de reintentar a ciegas.
            const value = await refresh();
            setMessage(value
                ? "La respuesta tardó más de lo esperado. Se actualizó el estado: revisá el resultado antes de volver a intentar."
                : "No se pudo conectar. Volvé a intentar.");
        } finally {
            setBusy(false);
        }
    }

    const needsInitial = Boolean(status?.initialData.required && !status.initialData.period);
    const running = status?.tasks.some((task) => task.status === "RUNNING" || task.status === "PENDING") ?? false;
    const canImport = Boolean(status?.configured) && !busy && !running && !(awaiting && !retryable) && !needsInitial;
    const hasTasks = (status?.tasks.length ?? 0) > 0;
    const step = needsInitial ? 1 : !hasTasks ? 2 : 3;
    return (
        <section className="card arca-panel" aria-label="Importación automática de ARCA">
            <div className="section-head">
                <div>
                    <h2>Importación automática de ARCA</h2>
                    <p>Descarga de ARCA y prepara una vista previa por fuente. Nada se incorpora hasta que la confirmes.</p>
                </div>
                <div className="toolbar">
                    <button type="button" className="btn btn-primary btn-lg" disabled={!canImport} onClick={() => void submit("POST")}>
                        {running ? "Descargando de ARCA…" : "Importar ahora"}
                    </button>
                </div>
            </div>
            {status?.initialData.required && (
                <ol className="steps" aria-label="Pasos">
                    <li className={step > 1 ? "is-done" : "is-current"}>Datos iniciales</li>
                    <li className={step > 2 ? "is-done" : step === 2 ? "is-current" : ""}>Importar</li>
                    <li className={step === 3 ? "is-current" : ""}>Revisar y confirmar</li>
                </ol>
            )}
            {status && !status.configured && <p className="callout callout-warning">Falta conectar el servicio de descarga de ARCA.</p>}
            {needsInitial && <p className="callout callout-info">Confirmá los datos iniciales de IVA Simple del período para importar.</p>}
            {awaiting && !retryable && <p className="callout callout-warning">Hay vistas previas sin resolver: confirmá o descartá cada una para poder descargar de nuevo.</p>}
            {message && <p role="status" className="callout callout-info">{message}</p>}
            {!message && <p role="status" className="sr-only" />}
            {status && (
                <ArcaInitialDataSection key={JSON.stringify(status.initialData.period)} url={url} status={status.initialData} canSaveDefault={canSchedule} busy={busy}
                    onSaved={(value) => apply(value as Status)} onMessage={setMessage} />
            )}
            {canSchedule && (
                <details className="schedule">
                    <summary>
                        Importación programada
                        <span className={`badge ${status?.schedule?.enabled ? "badge-success" : ""}`}>{status?.schedule?.enabled ? "Activa" : "Inactiva"}</span>
                    </summary>
                    <form className="stack" onSubmit={(event) => { event.preventDefault(); void submit("PUT"); }}>
                        <label className="check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Importar el día 25 de cada mes</label>
                        <div className="toolbar">
                            {days.map((day, index) => (
                                <label key={index} className="field">Día adicional {index + 1}
                                    <input type="number" min={1} max={31} value={day}
                                        onChange={(event) => setDays(days.map((value, position) => position === index ? event.target.value : value))} />
                                </label>
                            ))}
                        </div>
                        <small>El calendario importa el período abierto del mes en curso, en hora argentina.</small>
                        <div><button type="submit" className="btn btn-secondary" disabled={!status || busy}>Guardar calendario</button></div>
                    </form>
                </details>
            )}
            {hasTasks && (
                <div className="source-list">
            {status?.tasks.map((task) => {
                        const preview = task.preview;
                        const offersLegend = (task.status === "PREVIEW" || (task.status === "REVIEW" && task.correctable)) && task.source === "SALES" && preview?.consumerFinal !== undefined;
                        const confirmed = preview?.confirmed;
                        const shown: SyncVariant | null = !preview ? null
                            : (task.status === "PREVIEW" ? offersLegend && legend : (confirmed?.consumerFinalLegend ?? preview.consumerFinalApplied)) && preview.consumerFinal ? preview.consumerFinal : preview;
                        const correctsPending = task.correctable && (task.source === "SALES" || task.source === "PURCHASES") && task.pending > 0;
                        return (
                            <section key={task.source} aria-label={LABELS[task.source]} className="card source-card">
                                <div className="section-head">
                                    <div>
                                        <h3>{LABELS[task.source]}</h3>
                                        <p>
                                            {LABELS[task.status]}
                                            {task.downloaded !== null && task.status !== "EMPTY" && ` · ${task.downloaded} filas descargadas`}
                                            {task.imported ? ` · ${task.imported} incorporadas` : ""}
                                            {(confirmed?.consumerFinalLegend ?? preview?.consumerFinalApplied) && " con la leyenda «CONSUMIDOR FINAL»"}
                                            {preview?.files?.[0]?.format && ` · ${preview.files[0].format === "PORTAL_CSV" ? "Portal IVA" : preview.files[0].format === "MIS_COMPROBANTES" ? "Mis Comprobantes" : "Mis Retenciones"}`}
                                        </p>
                                    </div>
                                    <span className={`badge ${TASK_BADGE[task.status] ?? ""}`}>{SHORT_STATUS[task.status] ?? task.status}</span>
                                </div>
                                {task.errorCode && <p className="callout callout-error">{ERROR_LABELS[task.errorCode]}</p>}
                                {offersLegend && preview?.consumerFinal && (
                                    <label className="check callout">
                                        <input type="checkbox" checked={legend} disabled={busy} onChange={(event) => setLegend(event.target.checked)} />
                                        <span>
                                            <strong>Aplicar la leyenda «CONSUMIDOR FINAL»</strong> a las {preview.consumerFinal.rows} ventas con documento 99 sin denominación
                                            ({preview.consumerFinal.counts.OK} quedan aptas y {preview.consumerFinal.counts.REVIEW + preview.consumerFinal.counts.ERROR} siguen pendientes).
                                            <br /><small>Sólo completa la denominación: no cambia importes, alícuotas ni códigos.</small>
                                        </span>
                                    </label>
                                )}
                                {task.status === "PREVIEW" && (preview?.importedBefore ?? 0) > 0 && (
                                    <p className="callout callout-info">Corrección de pendientes: las {preview?.importedBefore} filas ya incorporadas de esta fuente aparecen como ya incorporadas y no se vuelven a incorporar.</p>
                                )}
                                {shown && task.status !== "DISCARDED" && <Variant variant={shown} />}
                                {correctsPending && task.status === "REVIEW" && (
                                    <>
                                        <ArcaPendingCorrections url={url} source={task.source as "SALES" | "PURCHASES"} legend={legend} busy={busy}
                                            onRevised={(value) => apply(value as Status)} onMessage={setMessage} />
                                        <div className="toolbar">
                                            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void decide(task.source, "discard")}>Cerrar sin corregir</button>
                                            <small>Borra el archivo guardado; lo ya incorporado se mantiene.</small>
                                        </div>
                                    </>
                                )}
                                {correctsPending && task.status === "PREVIEW" && (
                                    <ArcaPendingCorrections url={url} source={task.source as "SALES" | "PURCHASES"} legend={legend} busy={busy}
                                        onRevised={(value) => apply(value as Status)} onMessage={setMessage} />
                                )}
                                {task.status === "PREVIEW" && shown && (
                                    <div className="toolbar source-actions">
                                        <button type="button" className="btn btn-primary" disabled={busy || shown.counts.OK === 0} onClick={() => void decide(task.source, "confirm")}>
                                            Confirmar e incorporar {shown.counts.OK} filas
                                        </button>
                                        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void decide(task.source, "discard")}>Descartar</button>
                                        {shown.counts.OK === 0 && <small>No hay filas aptas para incorporar.</small>}
                                    </div>
                                )}
                            </section>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
