"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Msg = { tone: "status" | "alert"; text: string } | null;

async function send(url: string, method: string, body?: unknown) {
    const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, json };
}

/** Generar asientos del período y registrar pagos de impuestos (VEP). */
export function JournalActions({ clientId, periods, payAccounts }: {
    clientId: string;
    periods: { id: string; label: string }[];
    payAccounts: { id: string; label: string; role: string | null }[];
}) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [busy, setBusy] = useState(false);
    const [periodId, setPeriodId] = useState(periods[0]?.id ?? "");
    const [genMsg, setGenMsg] = useState<Msg>(null);
    const [payMsg, setPayMsg] = useState<Msg>(null);
    const defaultPay = payAccounts.find((a) => a.role === "WALLET") ?? payAccounts.find((a) => a.role === "BANK") ?? payAccounts[0];
    const [pay, setPay] = useState({ tax: "IIBB", date: new Date().toISOString().slice(0, 10), capital: "", interest: "", idcb: "", paymentAccountId: defaultPay?.id ?? "", reference: "" });

    async function run(fn: () => Promise<void>) {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true);
        try { await fn(); } finally { inFlight.current = false; setBusy(false); }
    }

    const generate = (kind: "VAT_POSITION" | "IIBB_POSITION") => run(async () => {
        setGenMsg(null);
        try {
            const { ok, json } = await send(`/api/periods/${encodeURIComponent(periodId)}/journal`, "POST", { kind });
            if (!ok) setGenMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo generar el asiento." });
            else { setGenMsg({ tone: "status", text: `Asiento N.º ${json.number} ${json.replaced ? "regenerado" : "registrado"}.` }); router.refresh(); }
        } catch { setGenMsg({ tone: "alert", text: "No se pudo generar el asiento." }); }
    });

    const savePayment = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
        setPayMsg(null);
        try {
            const { ok, json } = await send(`/api/clients/${encodeURIComponent(clientId)}/journal/tax-payment`, "POST", pay);
            if (!ok) setPayMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo registrar el pago." });
            else { setPayMsg({ tone: "status", text: `Pago registrado: asiento N.º ${json.number} (débitos y créditos computable ${json.idcbPercent} %).` }); setPay((p) => ({ ...p, capital: "", interest: "", idcb: "", reference: "" })); router.refresh(); }
        } catch { setPayMsg({ tone: "alert", text: "No se pudo registrar el pago." }); }
    }); };

    const set = (k: keyof typeof pay) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setPay({ ...pay, [k]: e.target.value });

    return (
        <div className="stack-lg">
            <section className="card" aria-labelledby="gen-title">
                <h2 id="gen-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Asientos del período</h2>
                {periods.length === 0 ? <p>El cliente no tiene períodos.</p> : (
                    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap", alignItems: "end" }}>
                        <label>Período
                            <select className="input" value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
                                {periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                            </select>
                        </label>
                        <button type="button" className="btn btn-primary" onClick={() => void generate("VAT_POSITION")}>Generar asiento de IVA</button>
                        <button type="button" className="btn btn-primary" onClick={() => void generate("IIBB_POSITION")}>Generar asiento de IIBB</button>
                    </fieldset>
                )}
                <p className="hint">Sale de la liquidación vigente del período. Si ya existe, se reemplaza conservando el número.</p>
                {genMsg && <p role={genMsg.tone}>{genMsg.text}</p>}
            </section>
            <form className="card" onSubmit={savePayment} aria-labelledby="pay-title">
                <h2 id="pay-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Registrar pago de impuesto (VEP)</h2>
                <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "var(--spacing-sm)", maxWidth: "36rem" }}>
                    <label>Impuesto
                        <select className="input" value={pay.tax} onChange={set("tax")}>
                            <option value="IIBB">Ingresos Brutos</option>
                            <option value="VAT">IVA</option>
                        </select>
                    </label>
                    <label>Fecha de pago<input className="input" type="date" value={pay.date} onChange={set("date")} required /></label>
                    <label>Impuesto pagado (capital)<input className="input" inputMode="decimal" value={pay.capital} onChange={set("capital")} placeholder="0,00" required /></label>
                    <label>Intereses resarcitorios<input className="input" inputMode="decimal" value={pay.interest} onChange={set("interest")} placeholder="0,00" /></label>
                    <label>Impuesto a los débitos y créditos del pago<input className="input" inputMode="decimal" value={pay.idcb} onChange={set("idcb")} placeholder="0,00" /></label>
                    <label>Pagado desde
                        <select className="input" value={pay.paymentAccountId} onChange={set("paymentAccountId")} required>
                            {payAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                        </select>
                    </label>
                    <label>Referencia (n.º de VEP)<input className="input" value={pay.reference} onChange={set("reference")} maxLength={60} /></label>
                    <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>{busy ? "Guardando…" : "Registrar pago"}</button>
                </fieldset>
                {payMsg && <p role={payMsg.tone}>{payMsg.text}</p>}
            </form>
        </div>
    );
}

export function DeleteEntryButton({ clientId, entryId, number }: { clientId: string; entryId: string; number: number }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    async function del() {
        setBusy(true); setErr(null);
        try {
            const { ok, json } = await send(`/api/clients/${encodeURIComponent(clientId)}/journal/${encodeURIComponent(entryId)}`, "DELETE");
            if (!ok) setErr(json?.error?.message ?? "No se pudo anular.");
            else router.refresh();
        } catch { setErr("No se pudo anular."); } finally { setBusy(false); setConfirm(false); }
    }
    if (!confirm) return <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)}>Anular</button>;
    return (
        <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <span>¿Anular el asiento N.º {number}?</span>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void del()}>Sí, anular</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirm(false)}>No</button>
            {err && <span role="alert">{err}</span>}
        </span>
    );
}
