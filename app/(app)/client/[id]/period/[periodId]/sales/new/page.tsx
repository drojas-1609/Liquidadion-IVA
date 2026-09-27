import { guardPage } from "@/lib/auth/authz";
import { loadInvoiceFormContext } from "@/lib/invoice-form-context";
import { AccessNotice } from "@/app/_components/access-notice";
import { InvoiceForm } from "../../_components/invoice-form";

export const dynamic = "force-dynamic";

// Alta de venta: OWNER / ADMIN / ACCOUNTANT (ROLES_CREATE). VIEWER ve el aviso
// de permisos; período de otra organización, de otro cliente o inexistente -> 404.
export default async function NewSalePage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const guard = await guardPage(() => loadInvoiceFormContext(id, periodId));
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;

    return <InvoiceForm direction="SALES" clientId={id} periodId={periodId} {...guard.data} />;
}
