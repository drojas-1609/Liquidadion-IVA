import { guardPage } from "@/lib/auth/authz";
import { loadInvoiceFormContext } from "@/lib/invoice-form-context";
import { AccessNotice } from "@/app/_components/access-notice";
import { InvoiceForm } from "../../_components/invoice-form";
import { PeriodClosedNotice } from "../../_components/period-closed-notice";

export const dynamic = "force-dynamic";

// Alta de compra: OWNER / ADMIN / ACCOUNTANT (ROLES_CREATE). VIEWER ve el aviso
// de permisos; período de otra organización, de otro cliente o inexistente -> 404.
export default async function NewPurchasePage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const guard = await guardPage(() => loadInvoiceFormContext(id, periodId));
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    // Período cerrado: aviso en lugar del formulario (la API rechaza igual).
    const { periodClosed, ...form } = guard.data;
    if (periodClosed) return <PeriodClosedNotice clientId={id} periodId={periodId} />;

    return <InvoiceForm direction="PURCHASES" clientId={id} periodId={periodId} {...form} />;
}
