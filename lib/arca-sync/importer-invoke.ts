import "server-only";
import { POST as previewInvoices } from "@/app/api/periods/[id]/libro-iva-import/preview/route";
import { POST as confirmInvoices } from "@/app/api/periods/[id]/libro-iva-import/confirm/route";
import { POST as importTaxes } from "@/app/api/periods/[id]/tax-import/route";
import type { Invoke } from "./preview-run";

/**
 * Llama a las rutas del importador existente dentro del mismo proceso. Cada
 * ruta vuelve a validar sesión (o la identidad de la corrida), permisos,
 * período y duplicados, y registra su auditoría.
 */
export function importerInvoke(baseUrl: string, periodId: string): Invoke {
    const handlers = { INVOICE_PREVIEW: previewInvoices, INVOICE_CONFIRM: confirmInvoices, TAX: importTaxes };
    return async (call, body) => {
        const request = new Request(new URL("/api/arca-import", baseUrl), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const result = await handlers[call](request, { params: Promise.resolve({ id: periodId }) });
        return { ok: result.ok, data: await result.json().catch(() => null) };
    };
}
