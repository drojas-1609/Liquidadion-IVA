"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { finishInvoicePerceptions } from "@/lib/invoice-perceptions-client";

/**
 * Sincroniza los tributos de las compras YA cargadas con lo declarado en el
 * Libro IVA Digital (TXT de comprobantes y alícuotas de compras). Muestra cada
 * cambio antes de aplicarlo; se puede excluir un proveedor (p. ej. cuando el
 * criterio del estudio para la DDJJ de IIBB difiere del Libro IVA). El total de
 * cada comprobante no cambia. Después concilia las percepciones.
 */

interface Item {
    invoiceId: string; supplierCuit: string | null; supplierName: string | null; voucher: string;
    applicable: boolean; excluded: boolean; reason: string | null;
    changes: { field: string; label: string; before: string; after: string }[];
}

async function toBase64(f: File): Promise<string> {
    const u = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(bin);
}

const money = (v: string) => Number(v).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function TributeSync({ clientId, periodId }: { clientId: string; periodId: string }) {
    const router = useRouter();
    const [vouchers, setVouchers] = useState<File | null>(null);
    const [aliquots, setAliquots] = useState<File | null>(null);
    const [items, setItems] = useState<Item[] | null>(null);
    const [token, setToken] = useState("");
    const [excluded, setExcluded] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const inFlight = useRef(false);

    async function call(extra: Record<string, unknown>, excl: string[]) {
        const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/tribute-sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                clientId, category: "PURCHASES", format: "LID_TXT",
                vouchersFile: await toBase64(vouchers!), aliquotsFile: await toBase64(aliquots!), excluded: excl, ...extra,
            }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(typeof json?.error?.message === "string" ? json.error.message : "No se pudo procesar.");
        return json;
    }

    async function preview(excl = excluded) {
        if (!vouchers || !aliquots || inFlight.current) return;
        inFlight.current = true; setBusy(true); setMessage(null);
        try {
            const json = await call({}, excl);
            setItems(json.items); setToken(json.token);
        } catch (e) {
            setMessage({ tone: "alert", text: (e as Error).message });
        } finally { inFlight.current = false; setBusy(false); }
    }

    async function apply() {
        if (!vouchers || !aliquots || inFlight.current) return;
        inFlight.current = true; setBusy(true); setMessage(null);
        try {
            let total = 0, first = true, pending = true, rounds = 0;
            while (pending && rounds < 30) {
                const r = await call(first ? { confirm: true, token } : { confirm: true, continue: true }, excluded);
                total += Number(r.applied ?? 0); pending = r.pending === true; first = false; rounds++;
            }
            // Las percepciones de IVA e IIBB se recalculan desde los comprobantes (en tramos).
            const linked = await finishInvoicePerceptions(periodId, { changes: 0, pending: true });
            setMessage({ tone: "status", text: `Se actualizaron ${total} comprobantes.${linked > 0 ? ` Percepciones conciliadas: ${linked} cambios.` : ""}` });
            setItems(null);
            router.refresh();
        } catch (e) {
            setMessage({ tone: "alert", text: (e as Error).message });
        } finally { inFlight.current = false; setBusy(false); }
    }

    const toggle = (cuit: string | null) => {
        if (!cuit) return;
        const next = excluded.includes(cuit) ? excluded.filter((c) => c !== cuit) : [...excluded, cuit];
        setExcluded(next);
        void preview(next);
    };
    const suppliers = items ? [...new Map(items.map((i) => [i.supplierCuit ?? "", i.supplierName ?? ""])).entries()] : [];
    const toApply = items?.filter((i) => i.applicable && !i.excluded).length ?? 0;

    return (
        <section className="card" aria-labelledby="tribute-sync-title" style={{ marginTop: "var(--spacing-xl)" }}>
            <h2 id="tribute-sync-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
                Tributos de compras según el Libro IVA Digital
            </h2>
            <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-md)" }}>
                Para compras ya cargadas: lleva percepciones (IVA, nacionales, IIBB, municipales), impuestos internos, otros
                tributos, no gravado y exento a lo declarado en el Libro IVA Digital. El total de cada comprobante no cambia.
                Podés excluir proveedores antes de aplicar.
            </p>
            <div style={{ display: "flex", gap: "var(--spacing-md)", flexWrap: "wrap", alignItems: "end" }}>
                <label>Comprobantes (TXT)<br /><input type="file" accept=".txt" onChange={(e) => { setVouchers(e.target.files?.[0] ?? null); setItems(null); }} /></label>
                <label>Alícuotas (TXT)<br /><input type="file" accept=".txt" onChange={(e) => { setAliquots(e.target.files?.[0] ?? null); setItems(null); }} /></label>
                <button type="button" className="btn btn-secondary" disabled={!vouchers || !aliquots || busy} onClick={() => preview()}>
                    {busy ? "Procesando…" : "Ver diferencias"}
                </button>
            </div>

            {items && items.length === 0 && <p role="status" style={{ marginTop: "var(--spacing-md)" }}>Los tributos de las compras ya coinciden con el Libro IVA.</p>}
            {items && items.length > 0 && (
                <>
                    <h3 style={{ fontSize: "1rem", fontWeight: 600, margin: "var(--spacing-md) 0 var(--spacing-xs)" }}>Proveedores</h3>
                    <div style={{ display: "flex", gap: "var(--spacing-md)", flexWrap: "wrap" }}>
                        {suppliers.map(([cuit, name]) => (
                            <label key={cuit}>
                                <input type="checkbox" checked={!excluded.includes(cuit)} disabled={busy} onChange={() => toggle(cuit)} /> {name || cuit}
                            </label>
                        ))}
                    </div>
                    <table style={{ width: "100%", fontSize: "0.8125rem", marginTop: "var(--spacing-md)", borderCollapse: "collapse" }}>
                        <thead><tr><th style={{ textAlign: "left" }}>Proveedor</th><th style={{ textAlign: "left" }}>Comprobante</th><th style={{ textAlign: "left" }}>Cambio</th><th style={{ textAlign: "left" }}>Estado</th></tr></thead>
                        <tbody>
                            {items.map((i) => (
                                <tr key={i.invoiceId} style={{ opacity: i.excluded ? 0.5 : 1, borderTop: "1px solid var(--border)" }}>
                                    <td>{i.supplierName}</td>
                                    <td>{i.voucher}</td>
                                    <td>{i.changes.map((c) => <div key={c.field}>{c.label}: {money(c.before)} → <strong>{money(c.after)}</strong></div>)}</td>
                                    <td>{i.excluded ? "Excluido" : i.applicable ? "Se actualiza" : <span style={{ color: "var(--error)" }}>{i.reason}</span>}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <button type="button" className="btn btn-primary" style={{ marginTop: "var(--spacing-md)" }} disabled={busy || toApply === 0} onClick={apply}>
                        {busy ? "Aplicando…" : `Aplicar a ${toApply} comprobantes`}
                    </button>
                </>
            )}
            {message && <p role={message.tone} style={{ marginTop: "var(--spacing-sm)", color: message.tone === "alert" ? "var(--error)" : "var(--success)" }}>{message.text}</p>}
        </section>
    );
}
