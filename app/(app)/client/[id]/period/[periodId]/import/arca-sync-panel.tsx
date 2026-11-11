"use client";

import { useEffect, useState } from "react";

const LABELS: Record<string, string> = {
    SALES: "Ventas", PURCHASES: "Compras", RETENTIONS: "Retenciones", PERCEPTIONS: "Percepciones",
    PENDING: "En espera", RUNNING: "En curso", DONE: "Importada", EMPTY: "Sin resultados",
    REVIEW: "Requiere revisión", AUTH_REQUIRED: "Sesión de ARCA vencida", FAILED: "Falló la importación",
};

const ERROR_LABELS: Record<string, string> = {
    REPRESENTATION_REQUIRED: "ARCA no confirmó el CUIT representado. Revisá los permisos del administrador para este servicio.",
    ARCA_SESSION: "Volvé a intentar para renovar la sesión.",
    VERIFICATION_REQUIRED: "ARCA pide una verificación para ingresar.",
    CREDENTIALS_MISSING: "Falta configurar el acceso de este CUIT.",
    ACCESS_REVOKED: "La cuenta que inició la corrida ya no tiene acceso al período.",
    DISPATCH_FAILED: "No se pudo iniciar el proceso de descarga.",
    ARCA_DOWNLOAD: "ARCA no entregó un archivo descargable.",
    ARCA_FORMAT: "El archivo no coincide con el formato de importación.",
    ARCA_IMPORT: "No se pudo confirmar la importación. Volvé a intentar.",
};

type Status = {
    configured: boolean;
    schedule: { enabled: boolean; extraDays: number[] } | null;
    tasks: Array<{
        source: string; status: string; downloaded: number | null; imported: number | null; duplicates: number | null;
        pending: number; errorCode: string | null; updatedAt: string;
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
    const active = status?.tasks.some((task) => task.status === "PENDING" || task.status === "RUNNING") ?? false;

    useEffect(() => {
        const controller = new AbortController();
        fetch(url, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
            if (!response.ok) throw new Error();
            const value: Status = await response.json();
            setStatus(value);
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

    return (
        <section className="card" style={{ marginBlock: "var(--spacing-md)" }} aria-label="Importación automática de ARCA">
            <h2>Importación automática de ARCA</h2>
            {status && !status.configured && <p>Falta conectar el servicio de descarga de ARCA.</p>}
            <button type="button" disabled={!status?.configured || busy || status.tasks.some((task) => task.status === "RUNNING")} onClick={() => void submit("POST")}>Importar ahora</button>
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
            {status?.tasks.length ? (
                <ul>{status.tasks.map((task) => (
                    <li key={task.source}>
                        {LABELS[task.source]} · {LABELS[task.status]}
                        {task.downloaded !== null && ` · ${task.downloaded} descargados, ${task.imported} importados, ${task.duplicates} duplicados`}
                        {task.errorCode && <p>{ERROR_LABELS[task.errorCode]}</p>}
                        {task.pending > 0 && <details>
                            <summary>{task.pending} filas pendientes</summary>
                            <ul>{task.issues.map((issue) => <li key={`${issue.file}-${issue.line}`}>
                                Fila {issue.line} del archivo {issue.file}. {issue.messages.join(" ")}
                            </li>)}</ul>
                        </details>}
                    </li>
                ))}</ul>
            ) : null}
        </section>
    );
}
