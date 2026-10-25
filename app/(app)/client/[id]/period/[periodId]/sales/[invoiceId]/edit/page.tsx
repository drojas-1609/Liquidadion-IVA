import { guardPage } from "@/lib/auth/authz";
import { loadInvoiceEditContext } from "@/lib/invoice-form-context";
import { AccessNotice } from "@/app/_components/access-notice";
import { InvoiceEditUnavailable, InvoiceForm } from "../../../_components/invoice-form";
import { PeriodClosedNotice } from "../../../_components/period-closed-notice";

export const dynamic = "force-dynamic";

// Edición de venta: OWNER / ADMIN / ACCOUNTANT (ROLES_UPDATE). VIEWER ve el aviso
// de permisos; organización, cliente, período, categoría o comprobante que no
// coinciden -> 404. Fila propia no editable -> aviso estable, sin formulario.
export default async function EditSalePage({
    params,
}: {
    params: Promise<{ id: string; periodId: string; invoiceId: string }>;
}) {
    const { id, periodId, invoiceId } = await params;

    const guard = await guardPage(() => loadInvoiceEditContext(id, periodId, invoiceId, "SALES"));
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { edit, periodClosed, ...form } = guard.data;
    // Período cerrado: aviso en lugar del formulario (la API rechaza igual).
    if (periodClosed) return <PeriodClosedNotice clientId={id} periodId={periodId} />;

    if (edit.status === "NOT_EDITABLE") {
        return <InvoiceEditUnavailable direction="SALES" clientId={id} periodId={periodId} clientName={form.clientName} period={form.period} message={edit.message} />;
    }
    // key: un updatedAt nuevo (p. ej. tras "Recargar datos") remonta el formulario con los datos actuales.
    return <InvoiceForm key={edit.form.updatedAt} direction="SALES" clientId={id} periodId={periodId} {...form} edit={edit.form} />;
}
