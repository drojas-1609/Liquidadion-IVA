import prisma from "@/lib/prisma";
import { supplierAccountCuit } from "@/lib/supplier-purchase-account";
import { PurchaseAccountForm } from "../../../_components/purchase-account-form";
import { guardPage } from "@/lib/auth/authz";
import { loadInvoiceEditContext } from "@/lib/invoice-form-context";
import { AccessNotice } from "@/app/_components/access-notice";
import { InvoiceEditUnavailable, InvoiceForm } from "../../../_components/invoice-form";
import { PeriodClosedNotice } from "../../../_components/period-closed-notice";
import { ImportedInvoiceForm } from "../../../_components/imported-invoice-form";

export const dynamic = "force-dynamic";

// Edición de compra: OWNER / ADMIN / ACCOUNTANT / OPERATOR (ROLES_UPDATE). VIEWER ve el aviso
// de permisos; organización, cliente, período, categoría o comprobante que no
// coinciden -> 404. Fila propia no editable -> aviso estable, sin formulario.
export default async function EditPurchasePage({
    params,
}: {
    params: Promise<{ id: string; periodId: string; invoiceId: string }>;
}) {
    const { id, periodId, invoiceId } = await params;

    const guard = await guardPage(() => loadInvoiceEditContext(id, periodId, invoiceId, "PURCHASES"));
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { edit, periodClosed, ...form } = guard.data;
    // Período cerrado: aviso en lugar del formulario (la API rechaza igual).
    if (periodClosed) return <PeriodClosedNotice clientId={id} periodId={periodId} />;

    const purchase = await prisma.invoice.findFirst({
        where: { id: invoiceId, periodId, category: "PURCHASES", period: { clientId: id } },
        select: { organizationId: true, purchaseAccount: true, updatedAt: true, counterpartyDocType: true, counterpartyDocNumber: true },
    });
    const supplierCuit = purchase && supplierAccountCuit(purchase.counterpartyDocType, purchase.counterpartyDocNumber ?? null);
    const rule = purchase && supplierCuit ? await prisma.supplierPurchaseAccount.findUnique({
        where: { organizationId_clientId_supplierCuit: { organizationId: purchase.organizationId, clientId: id, supplierCuit } },
        select: { account: true },
    }) : null;
    const accountForm = purchase && <PurchaseAccountForm key={purchase.updatedAt.toISOString()} periodId={periodId} invoiceId={invoiceId} updatedAt={purchase.updatedAt.toISOString()} cuit={supplierCuit} current={purchase.purchaseAccount} supplierRule={rule?.account ?? null} />;

    if (edit.status === "IMPORTED") {
        // Importado: formulario detallado (todas las alícuotas e importes); key con el token para remontar tras recargar.
        return <>{accountForm}<ImportedInvoiceForm key={edit.detail.updatedAt} clientId={id} periodId={periodId} clientName={form.clientName} period={form.period} detail={edit.detail} /></>;
    }
    if (edit.status === "NOT_EDITABLE") {
        return <InvoiceEditUnavailable direction="PURCHASES" clientId={id} periodId={periodId} clientName={form.clientName} period={form.period} message={edit.message} />;
    }
    // key: un updatedAt nuevo (p. ej. tras "Recargar datos") remonta el formulario con los datos actuales.
    return <>{accountForm}<InvoiceForm key={edit.form.updatedAt} direction="PURCHASES" clientId={id} periodId={periodId} {...form} edit={edit.form} /></>;
}
