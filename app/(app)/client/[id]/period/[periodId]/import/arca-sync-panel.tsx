"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/format";
import type { SyncPreviewSummary, SyncVariant } from "@/lib/arca-sync/preview";
import { ArcaPendingCorrections } from "./arca-pending-corrections";

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
        <>
            <table className="table">
                <thead><tr><th>Nuevas</th><th>Duplicadas</th><th>Pendientes</th><th>Errores</th></tr></thead>
                <tbody><tr><td>{counts.OK}</td><td>{counts.DUPLICATE}</td><td>{counts.REVIEW}</td><td>{counts.ERROR}</td></tr></tbody>
            </table>
            {invoices && counts.OK > 0 && (
                <table className="table">
                    <caption>Filas nuevas (las notas de crédito restan)</caption>
                    <thead><tr><th>Concepto</th><th>Neto</th><th>IVA</th></tr></thead>
                    <tbody>
                        {invoices.byRate.map((rate) => <tr key={rate.code}><td>{RATE_LABELS[rate.code] ?? `Alícuota ${rate.code}`}</td><td>{money(rate.net)}</td><td>{money(rate.vat)}</td></tr>)}
                        <tr><td>No gravado</td><td>{money(invoices.importable.nonTaxed)}</td><td /></tr>
                        <tr><td>Exento</td><td>{money(invoices.importable.exempt)}</td><td /></tr>
                        <tr><td>Otros tributos y percepciones</td><td>{money(invoices.importable.otherTaxes)}</td><td /></tr>
                        <tr><th scope="row">Total</th><td>{money(invoices.importable.total)}</td><td>{money(invoices.importable.vat)}</td></tr>
                    </tbody>
                </table>
            )}
            {invoices && (counts.REVIEW > 0 || counts.DUPLICATE > 0 || counts.ERROR > 0) && (
                <p>
                    Sin incorporar: pendientes {money(invoices.pendingTotal)}
                    {counts.DUPLICATE > 0 && ` · duplicadas ${money(invoices.duplicateTotal)}`}
                    {counts.ERROR > 0 && ` · con error ${money(invoices.errorInformedTotal)} (total informado)`}
                </p>
            )}
            {taxes && <p>Total de filas nuevas: {money(taxes.importableTotal)}{taxes.excludedTotal !== "0.00" && ` · sin incorporar: ${money(taxes.excludedTotal)}`}</p>}
            {reasons.length > 0 && (
                <table className="table">
                    <caption>Filas sin incorporar, por motivo (una fila puede tener más de uno)</caption>
                    <thead><tr><th>Estado</th><th>Motivo</th><th>Filas</th></tr></thead>
                    <tbody>{reasons.map((reason) => <tr key={`${reason.status}-${reason.message}`}><td>{STATUS_LABELS[reason.status]}</td><td>{reason.message}</td><td>{reason.rows}</td></tr>)}</tbody>
                </table>
            )}
        </>
    );
}

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
};

type Status = {
    configured: boolean;
    schedule: { enabled: boolean; extraDays: number[] } | null;
    tasks: Array<{
        source: string; status: string; downloaded: number | null; imported: number | null; duplicates: number | null;
        pending: number; errorCode: string | null; updatedAt: string;
        preview: SyncPreviewSummary | null;
        /** El archivo sigue guardado: las filas pendientes se pueden revisar y corregir. */
        correctable: boolean;
        issues: Array<{ file: number; line: number; status: string; messages: string[] }>;
    }>;
};

export function ArcaSyncPanel({ periodId, canSchedule }: { periodId: string; canSchedule: boolean }) {
    const url = `/api/periods/${encodeURIComponent(periodId)}/arca-sync`;
    const [status, setStatus] = useState<Status>();
    const [enabled, setEnabled] = useState(false);
    const [days, setDays] = useState(["", ""]);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [legend, setLegend] = useState(false);
    const active = status?.tasks.some((task) => task.status === "PENDING" || task.status === "RUNNING" || task.status === "CONFIRMING") ?? false;
    const awaiting = status?.tasks.some((task) => task.status === "PREVIEW" || task.status === "CONFIRMING") ?? false;
    const retryable = status?.tasks.some((task) => task.status === "FAILED" || task.status === "AUTH_REQUIRED") ?? false;

    useEffect(() => {
        const controller = new AbortController();
        fetch(url, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
            if (!response.ok) throw new Error();
            const value: Status = await response.json();
            setStatus(value);
            // Si las ventas ya se incorporaron con la leyenda, la corrección parte de esa variante.
            const sales = value.tasks.find((task) => task.source === "SALES")?.preview;
            if ((sales?.confirmed?.consumerFinalLegend ?? sales?.consumerFinalApplied) === true) setLegend(true);
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
                if (response.ok) setStatus(await response.json());
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
            setStatus(result);
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
                const fresh = await fetch(url, { cache: "no-store" });
                if (fresh.ok) setStatus(await fresh.json());
                return;
            }
            setStatus(result);
            setMessage(action === "confirm" ? `${LABELS[source]}: incorporación confirmada.` : `${LABELS[source]}: vista previa descartada.`);
        } catch {
            setMessage("No se pudo conectar. Volvé a intentar.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card" style={{ marginBlock: "var(--spacing-md)" }} aria-label="Importación automática de ARCA">
            <h2>Importación automática de ARCA</h2>
            {status && !status.configured && <p>Falta conectar el servicio de descarga de ARCA.</p>}
            <button type="button" disabled={!status?.configured || busy || status.tasks.some((task) => task.status === "RUNNING") || (awaiting && !retryable)} onClick={() => void submit("POST")}>Importar ahora</button>
            <p>«Importar ahora» descarga de ARCA y prepara una vista previa por fuente. Nada se incorpora hasta que la confirmes.</p>
            {awaiting && !retryable && <p>Hay vistas previas sin resolver: confirmá o descartá cada una para poder descargar de nuevo.</p>}
            {canSchedule && (
                <form onSubmit={(event) => { event.preventDefault(); void submit("PUT"); }}>
                    <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Importar el día 25 de cada mes</label>
                    <p>El calendario importa el período abierto del mes en curso, en hora argentina.</p>
                    {days.map((day, index) => (
                        <label key={index}>Día adicional {index + 1}
                            <input type="number" min={1} max={31} value={day}
                                onChange={(event) => setDays(days.map((value, position) => position === index ? event.target.value : value))} />
                        </label>
                    ))}
                    <button type="submit" disabled={!status || busy}>Guardar calendario</button>
                </form>
            )}
            <p role="status">{message}</p>
            {status?.tasks.map((task) => {
                const preview = task.preview;
                const offersLegend = (task.status === "PREVIEW" || (task.status === "REVIEW" && task.correctable)) && task.source === "SALES" && preview?.consumerFinal !== undefined;
                const confirmed = preview?.confirmed;
                const shown: SyncVariant | null = !preview ? null
                    : (task.status === "PREVIEW" ? offersLegend && legend : (confirmed?.consumerFinalLegend ?? preview.consumerFinalApplied)) && preview.consumerFinal ? preview.consumerFinal : preview;
                const correctsPending = task.correctable && (task.source === "SALES" || task.source === "PURCHASES") && task.pending > 0;
                return (
                    <section key={task.source} aria-label={LABELS[task.source]}>
                        <h3>{LABELS[task.source]}</h3>
                        <p>
                            {LABELS[task.status]}
                            {task.downloaded !== null && task.status !== "EMPTY" && ` · ${task.downloaded} filas descargadas`}
                            {task.imported ? ` · ${task.imported} incorporadas` : ""}
                            {(confirmed?.consumerFinalLegend ?? preview?.consumerFinalApplied) && " con la leyenda «CONSUMIDOR FINAL»"}
                        </p>
                        {task.errorCode && <p>{ERROR_LABELS[task.errorCode]}</p>}
                        {offersLegend && preview?.consumerFinal && (
                            <label>
                                <input type="checkbox" checked={legend} disabled={busy} onChange={(event) => setLegend(event.target.checked)} />
                                {` Aplicar la leyenda «CONSUMIDOR FINAL» a las ${preview.consumerFinal.rows} ventas con documento 99 sin denominación `}
                                ({preview.consumerFinal.counts.OK} quedan aptas y {preview.consumerFinal.counts.REVIEW + preview.consumerFinal.counts.ERROR} siguen pendientes).
                                Sólo completa la denominación: no cambia importes, alícuotas ni códigos.
                            </label>
                        )}
                        {task.status === "PREVIEW" && (preview?.importedBefore ?? 0) > 0 && (
                            <p>Corrección de pendientes: las {preview?.importedBefore} filas ya incorporadas de esta fuente aparecen como duplicadas y no se vuelven a incorporar.</p>
                        )}
                        {shown && task.status !== "DISCARDED" && <Variant variant={shown} />}
                        {correctsPending && task.status === "REVIEW" && (
                            <>
                                <ArcaPendingCorrections url={url} source={task.source as "SALES" | "PURCHASES"} legend={legend} busy={busy}
                                    onRevised={(value) => setStatus(value as Status)} onMessage={setMessage} />
                                <p>
                                    <button type="button" className="btn" disabled={busy} onClick={() => void decide(task.source, "discard")}>Cerrar sin corregir</button>
                                    {" "}Borra el archivo guardado; lo ya incorporado se mantiene.
                                </p>
                            </>
                        )}
                        {correctsPending && task.status === "PREVIEW" && (
                            <ArcaPendingCorrections url={url} source={task.source as "SALES" | "PURCHASES"} legend={legend} busy={busy}
                                onRevised={(value) => setStatus(value as Status)} onMessage={setMessage} />
                        )}
                        {task.status === "PREVIEW" && shown && (
                            <p>
                                <button type="button" className="btn btn-primary" disabled={busy || shown.counts.OK === 0} onClick={() => void decide(task.source, "confirm")}>
                                    Confirmar e incorporar {shown.counts.OK} filas
                                </button>{" "}
                                <button type="button" className="btn" disabled={busy} onClick={() => void decide(task.source, "discard")}>Descartar</button>
                                {shown.counts.OK === 0 && " No hay filas aptas para incorporar."}
                            </p>
                        )}
                    </section>
                );
            })}
        </section>
    );
}
