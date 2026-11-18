"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { finishInvoicePerceptions } from "@/lib/invoice-perceptions-client";

/** Concilia a pedido las percepciones cargadas en los comprobantes de compra del período. */
export function InvoicePerceptionsSync({ periodId }: { periodId: string }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    async function run() {
        setBusy(true);
        setMessage("");
        try {
            const response = await fetch(`/api/periods/${encodeURIComponent(periodId)}/invoice-perceptions`, { method: "POST" });
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error(body?.error?.message ?? "No se pudo conciliar.");
            const total = await finishInvoicePerceptions(periodId, { changes: Number(body?.changes ?? 0), pending: body?.pending === true });
            setMessage(total === 0 ? "Ya estaba todo conciliado." : `Listo: ${total} cambios.`);
            router.refresh();
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "No se pudo conciliar.");
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="callout callout-info" style={{ marginBottom: "var(--spacing-md)", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 320px" }}>
                Las percepciones de IVA e IIBB cargadas en las compras se registran acá solas: si ARCA ya informó la misma
                percepción, se vincula y computa lo de ARCA; si no, se toma del comprobante (IIBB, a la jurisdicción sede).
            </span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run()}>
                {busy ? "Conciliando…" : "Conciliar con las compras"}
            </button>
            {message && <span role="status" className="text-sm">{message}</span>}
        </div>
    );
}
