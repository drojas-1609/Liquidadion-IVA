"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Msg = { tone: "status" | "alert"; text: string } | null;
type PeriodOpt = { id: string; label: string; open: boolean; f931: { contributionsBase: string; employerContributions: string; reference: string } | null };

async function send(url: string, method: string, body?: unknown) {
    const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { ok: res.ok, json: await res.json().catch(() => null) };
}
const toInput = (s: string) => s.replace(".", ",");

export function PayrollForms({ clientId, zoneCode, zones, periods, payAccounts, hasChart }: {
    clientId: string; zoneCode: number | null; zones: { code: number; label: string }[];
    periods: PeriodOpt[]; payAccounts: { id: string; label: string; role: string | null }[]; hasChart: boolean;
}) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [busy, setBusy] = useState(false);
    const [zone, setZone] = useState(zoneCode ? String(zoneCode) : "");
    const [zoneMsg, setZoneMsg] = useState<Msg>(null);
    const first = periods.find((p) => p.open) ?? periods[0];
    const [f931, setF931] = useState({ periodId: first?.id ?? "", contributionsBase: first?.f931 ? toInput(first.f931.contributionsBase) : "", employerContributions: first?.f931 ? toInput(first.f931.employerContributions) : "", reference: first?.f931?.reference ?? "" });
    const [f931Msg, setF931Msg] = useState<Msg>(null);
    const defPay = payAccounts.find((a) => a.role === "BANK") ?? payAccounts[0];
    const [slip, setSlip] = useState({ periodId: first?.id ?? "", union: "", amount: "", paid: false, paidDate: new Date().toISOString().slice(0, 10), paymentAccountId: defPay?.id ?? "", reference: "" });
    const [slipMsg, setSlipMsg] = useState<Msg>(null);

    async function run(fn: () => Promise<void>) {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true);
        try { await fn(); } finally { inFlight.current = false; setBusy(false); }
    }
    const err = (json: { error?: { message?: string } } | null, fallback: string) => json?.error?.message ?? fallback;

    const saveZone = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
        const { ok, json } = await send(`/api/clients/${encodeURIComponent(clientId)}/payroll-zone`, "PUT", { zoneCode: zone === "" ? null : Number(zone) });
        setZoneMsg(ok ? { tone: "status", text: "Zona guardada." } : { tone: "alert", text: err(json, "No se pudo guardar la zona.") });
        if (ok) router.refresh();
    }); };

    const pickF931Period = (pid: string) => {
        const p = periods.find((x) => x.id === pid);
        setF931({ periodId: pid, contributionsBase: p?.f931 ? toInput(p.f931.contributionsBase) : "", employerContributions: p?.f931 ? toInput(p.f931.employerContributions) : "", reference: p?.f931?.reference ?? "" });
    };
    const saveF931 = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
        setF931Msg(null);
        const { periodId, ...body } = f931;
        const { ok, json } = await send(`/api/periods/${encodeURIComponent(periodId)}/payroll-f931`, "PUT", body);
        if (!ok) { setF931Msg({ tone: "alert", text: err(json, "No se pudo grabar el F.931.") }); return; }
        setF931Msg({ tone: "status", text: `F.931 grabado. Crédito fiscal Anexo I: $ ${json.credit.replace(".", ",")} (zona ${json.zoneCode}, ${json.percent.replace(".", ",")} %), ya cargado en la liquidación de IVA.${json.entryNumber ? ` Asiento N.º ${json.entryNumber}.` : ""}` });
        router.refresh();
    }); };

    const saveSlip = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
        setSlipMsg(null);
        const body = { periodId: slip.periodId, union: slip.union, amount: slip.amount, reference: slip.reference, ...(slip.paid ? { paidDate: slip.paidDate, paymentAccountId: slip.paymentAccountId } : {}) };
        const { ok, json } = await send(`/api/clients/${encodeURIComponent(clientId)}/union-slips`, "POST", body);
        if (!ok) { setSlipMsg({ tone: "alert", text: err(json, "No se pudo registrar la boleta.") }); return; }
        setSlipMsg({ tone: "status", text: `Boleta registrada: asiento N.º ${json.accrualNumber}${json.paymentNumber ? ` y pago N.º ${json.paymentNumber}` : ""}.` });
        setSlip((s) => ({ ...s, amount: "", reference: "" }));
        router.refresh();
    }); };

    const h2 = { fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" } as const;
    const grid = { border: 0, padding: 0, margin: 0, display: "grid", gap: "var(--spacing-sm)", maxWidth: "36rem" } as const;
    return (
        <div className="stack-lg">
            <form className="card" onSubmit={saveZone}>
                <h2 style={h2}>Zona del Anexo I (Ley 27.541)</h2>
                <fieldset disabled={busy} style={grid}>
                    <label>Código zonal del empleador
                        <select className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
                            <option value="">— Sin definir —</option>
                            {zones.map((z) => <option key={z.code} value={z.code}>{z.label}</option>)}
                        </select>
                    </label>
                    <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Guardar zona</button>
                </fieldset>
                {zoneMsg && <p role={zoneMsg.tone}>{zoneMsg.text}</p>}
            </form>
            <form className="card" onSubmit={saveF931}>
                <h2 style={h2}>F.931 del período</h2>
                <fieldset disabled={busy || periods.length === 0} style={grid}>
                    <label>Período
                        <select className="input" value={f931.periodId} onChange={(e) => pickF931Period(e.target.value)}>
                            {periods.map((p) => <option key={p.id} value={p.id}>{p.label}{p.open ? "" : " (cerrado)"}</option>)}
                        </select>
                    </label>
                    <label>Base imponible de contribuciones patronales<input className="input" inputMode="decimal" value={f931.contributionsBase} onChange={(e) => setF931({ ...f931, contributionsBase: e.target.value })} placeholder="0,00" required /></label>
                    <label>Total de contribuciones patronales a pagar<input className="input" inputMode="decimal" value={f931.employerContributions} onChange={(e) => setF931({ ...f931, employerContributions: e.target.value })} placeholder="0,00" required /></label>
                    <label>Referencia (opcional)<input className="input" value={f931.reference} onChange={(e) => setF931({ ...f931, reference: e.target.value })} maxLength={120} placeholder="p. ej. F.931 10/2026 · VEP 123" /></label>
                    <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Grabar F.931</button>
                </fieldset>
                <p className="hint">El crédito (base × puntos de la zona) se carga en la liquidación de IVA del mismo período; con el período cerrado no se puede modificar.</p>
                {f931Msg && <p role={f931Msg.tone}>{f931Msg.text}</p>}
            </form>
            <form className="card" onSubmit={saveSlip}>
                <h2 style={h2}>Boleta sindical</h2>
                <fieldset disabled={busy || !hasChart || periods.length === 0} style={grid}>
                    <label>Período
                        <select className="input" value={slip.periodId} onChange={(e) => setSlip({ ...slip, periodId: e.target.value })}>
                            {periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                    </label>
                    <label>Sindicato<input className="input" value={slip.union} onChange={(e) => setSlip({ ...slip, union: e.target.value })} placeholder="p. ej. FAECYS, SEC, UTHGRA" maxLength={80} required /></label>
                    <label>Importe<input className="input" inputMode="decimal" value={slip.amount} onChange={(e) => setSlip({ ...slip, amount: e.target.value })} placeholder="0,00" required /></label>
                    <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}><input type="checkbox" checked={slip.paid} onChange={(e) => setSlip({ ...slip, paid: e.target.checked })} /> Ya está pagada</label>
                    {slip.paid && (<>
                        <label>Fecha de pago<input className="input" type="date" value={slip.paidDate} onChange={(e) => setSlip({ ...slip, paidDate: e.target.value })} required /></label>
                        <label>Pagada desde
                            <select className="input" value={slip.paymentAccountId} onChange={(e) => setSlip({ ...slip, paymentAccountId: e.target.value })}>
                                {payAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                            </select>
                        </label>
                    </>)}
                    <label>Referencia (opcional)<input className="input" value={slip.reference} onChange={(e) => setSlip({ ...slip, reference: e.target.value })} maxLength={120} /></label>
                    <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Registrar boleta</button>
                </fieldset>
                {slipMsg && <p role={slipMsg.tone}>{slipMsg.text}</p>}
            </form>
        </div>
    );
}

export function DeleteSlipButton({ clientId, slipId }: { clientId: string; slipId: string }) {
    const router = useRouter();
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    async function del() {
        setBusy(true);
        try { const { ok } = await send(`/api/clients/${encodeURIComponent(clientId)}/union-slips/${encodeURIComponent(slipId)}`, "DELETE"); if (ok) router.refresh(); }
        finally { setBusy(false); setConfirm(false); }
    }
    if (!confirm) return <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)}>Borrar</button>;
    return (<span style={{ display: "flex", gap: "0.5rem" }}><span>¿Borrar la boleta y sus asientos?</span><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void del()}>Sí</button><button type="button" className="btn btn-secondary" onClick={() => setConfirm(false)}>No</button></span>);
}
