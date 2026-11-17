import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { recordAudit } from "@/lib/auth/audit";
import { requireAuthenticatedProfile, requirePeriodAccess, resolveActiveOrganization, withApiAuthz } from "@/lib/auth/authz";
import { NotFoundError } from "@/lib/auth/errors";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { reconcileInvoicePerceptions } from "@/lib/invoice-perceptions";

/**
 * Concilia a pedido las percepciones de los comprobantes de compra del período
 * con Retenciones/Percepciones (lib/invoice-perceptions). Para los períodos
 * cargados antes de que la conciliación fuera automática; es idempotente.
 */
export const POST = withApiAuthz(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const { period } = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (period.organizationId !== organizationId) throw new NotFoundError();

    const changes = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const count = await reconcileInvoicePerceptions(tx, { organizationId, periodId: id, clientId: period.clientId, profileId });
        if (count > 0) {
            await recordAudit(tx, {
                organizationId, actorProfileId: profileId, action: "taxrecord.invoice_perceptions",
                targetType: "Period", targetId: id, metadata: { periodId: id, changes: count },
            });
        }
        return count;
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json({ changes });
});
