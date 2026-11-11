"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestCuitLookup } from "@/lib/arca-lookup-client";
import { suggestSupplierAccounts } from "@/lib/supplier-purchase-account";

export function PurchaseAccountForm({ periodId, invoiceId, updatedAt, cuit, current, supplierRule }: {
    periodId: string;
    invoiceId: string;
    updatedAt: string;
    cuit: string | null;
    current: string | null;
    supplierRule: string | null;
}) {
    const router = useRouter();
    const [account, setAccount] = useState(current ?? supplierRule ?? "");
    const [saveRule, setSaveRule] = useState(false);
    const [suggestions, setSuggestions] = useState<ReturnType<typeof suggestSupplierAccounts>>([]);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    async function consult() {
        if (!cuit) return;
        setBusy(true);
        try {
            const result = await requestCuitLookup(cuit);
            if (result.status === "FOUND") {
                setSuggestions(suggestSupplierAccounts(result.person.activities));
                setMessage(result.person.activities.length ? "" : "El padrón no devolvió actividades.");
            } else {
                setSuggestions([]);
                setMessage("No se obtuvieron actividades de ARCA. Podés elegir la cuenta manualmente.");
            }
        } finally {
            setBusy(false);
        }
    }

    async function save() {
        setBusy(true);
        try {
            const result = await fetch(`/api/periods/${encodeURIComponent(periodId)}/purchase-account`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ invoiceId, updatedAt, account, saveRule }),
            });
            setMessage(result.ok ? "Cuenta guardada." : "No se pudo guardar. Revisá tus permisos o recargá la compra.");
            if (result.ok) router.refresh();
        } catch {
            setMessage("No se pudo conectar. Recargá para comprobar el estado de la compra.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card">
            <h2>Cuenta contable de la compra</h2>
            {supplierRule && <p>Regla vigente del proveedor: {supplierRule}</p>}
            <p>Elegí la cuenta según la compra. El concepto fiscal se completa en Presentación ARCA.</p>
            {cuit && <button type="button" disabled={busy} onClick={consult}>Sugerir por actividad de ARCA</button>}
            {suggestions.length > 0 && (
                <ul>
                    {suggestions.map((item, index) => (
                        <li key={`${item.code}-${index}`}>
                            <button type="button" disabled={busy} onClick={() => setAccount(item.account)}>{item.account}</button>
                            {" "}{item.code} {item.description}
                        </li>
                    ))}
                </ul>
            )}
            <label>Cuenta contable <input value={account} maxLength={120} onChange={(e) => setAccount(e.target.value)} /></label>
            {cuit && <label><input type="checkbox" checked={saveRule} onChange={(e) => setSaveRule(e.target.checked)} /> Usar en futuras importaciones de este proveedor para esta empresa</label>}
            <button type="button" disabled={busy || !account.trim()} onClick={save}>Guardar cuenta</button>
            <p role="status">{message}</p>
        </section>
    );
}
