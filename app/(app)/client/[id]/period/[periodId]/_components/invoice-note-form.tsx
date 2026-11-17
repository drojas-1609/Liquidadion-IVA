"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Nota del papel de trabajo del comprobante (no se informa a ARCA; sale en el Excel). */
export function InvoiceNoteForm({ periodId, invoiceId, updatedAt, current }: { periodId: string; invoiceId: string; updatedAt: string; current: string | null }) {
    const router = useRouter();
    const [note, setNote] = useState(current ?? "");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    async function save() {
        setBusy(true);
        try {
            const result = await fetch(`/api/periods/${encodeURIComponent(periodId)}/invoice-note`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ invoiceId, updatedAt, note }),
            });
            setMessage(result.ok ? (note.trim() ? "Nota guardada." : "Nota borrada.") : "No se pudo guardar. Revisá tus permisos o recargá el comprobante.");
            if (result.ok) router.refresh();
        } catch {
            setMessage("No se pudo conectar. Recargá para comprobar el estado del comprobante.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card stack" style={{ marginBottom: "var(--spacing-md)" }}>
            <div className="section-head" style={{ marginBottom: 0 }}>
                <div>
                    <h2>Nota del papel de trabajo</h2>
                    <p>Aclaraciones del control del comprobante físico. No se informa a ARCA ni cambia importes; sale en el Excel.</p>
                </div>
            </div>
            <label className="field">Nota
                <textarea value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="toolbar">
                <button type="button" className="btn btn-primary" disabled={busy || note.trim() === (current ?? "")} onClick={save}>{busy ? "Guardando…" : "Guardar nota"}</button>
                <small className="muted">{note.length}/500</small>
                <span role="status" className="text-sm">{message}</span>
            </div>
        </section>
    );
}
