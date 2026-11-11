import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { recordAudit } from "@/lib/auth/audit";
import { parseJsonBody, requireAuthenticatedProfile, requirePeriodAccess, resolveActiveOrganization, withApiAuthz } from "@/lib/auth/authz";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { supplierAccountCuit } from "@/lib/supplier-purchase-account";
import { lockPeriodForWrite } from "@/lib/period-lock";

export const PATCH = withApiAuthz(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const { period } = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (period.organizationId !== organizationId) throw new NotFoundError();

    const body = await parseJsonBody(request) as Record<string, unknown> | null;
    const account = typeof body?.account === "string" ? body.account.trim() : "";
    if (!account || account.length > 120) throw new ValidationError("Ingresá una cuenta de hasta 120 caracteres", "account");
    const invoiceId = typeof body?.invoiceId === "string" ? body.invoiceId : "";
    const savedSupplierRule = body?.saveRule === true;

    await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const invoice = await tx.invoice.findFirst({
            where: { id: invoiceId, periodId: id, organizationId, category: "PURCHASES" },
            select: { counterpartyDocType: true, counterpartyDocNumber: true, updatedAt: true },
        });
        if (!invoice) throw new NotFoundError();
        if (invoice.updatedAt.toISOString() !== body?.updatedAt) throw new ConflictError("La compra cambió. Recargá la página antes de guardar.");
        const supplierCuit = supplierAccountCuit(invoice.counterpartyDocType, invoice.counterpartyDocNumber ?? null);
        if (savedSupplierRule) {
            if (!supplierCuit) throw new ValidationError("La regla requiere un CUIT válido", "supplierCuit");
            const scope = { organizationId, clientId: period.clientId, supplierCuit };
            await tx.supplierPurchaseAccount.upsert({
                where: { organizationId_clientId_supplierCuit: scope },
                create: { ...scope, account },
                update: { account },
            });
        }
        await tx.invoice.update({ where: { id: invoiceId }, data: { purchaseAccount: account, updatedById: profileId } });
        await recordAudit(tx, {
            organizationId, actorProfileId: profileId, action: "invoice.purchase_account_change",
            targetType: "Invoice", targetId: invoiceId, metadata: { periodId: id, savedSupplierRule },
        });
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json({ account });
});
