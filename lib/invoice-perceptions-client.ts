/**
 * Lado cliente de la conciliación por tramos (lib/invoice-perceptions):
 * mientras el servidor informe `pending`, pide otro tramo. Cada tramo es una
 * transacción completa; el tope evita un bucle si algo no converge.
 */
export const RECONCILE_MAX_ROUNDS = 30;

export async function finishInvoicePerceptions(periodId: string, first: { changes: number; pending: boolean }): Promise<number> {
    let total = first.changes;
    let pending = first.pending;
    for (let round = 0; pending && round < RECONCILE_MAX_ROUNDS; round++) {
        const response = await fetch(`/api/periods/${encodeURIComponent(periodId)}/invoice-perceptions`, { method: "POST" });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error?.message ?? "No se pudo terminar la conciliación.");
        total += Number(body?.changes ?? 0);
        pending = body?.pending === true;
    }
    if (pending) throw new Error("La conciliación quedó a medias; volvé a intentar.");
    return total;
}
