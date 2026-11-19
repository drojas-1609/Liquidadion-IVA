import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/auth/errors";

// DELETE /api/clients/[id]/union-slips/[slipId] — borra la boleta y sus asientos.
export const DELETE = withApiAuthz(async (_request: Request, ctx: { params: Promise<{ id: string; slipId: string }> }) => {
    const { id, slipId } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    await prisma.$transaction(async (tx) => {
        const slip = await tx.payrollUnionSlip.findFirst({ where: { id: slipId, clientId: id, organizationId }, select: { id: true, union: true, accrualEntryId: true, paymentEntryId: true } });
        if (!slip) throw new NotFoundError();
        const entryIds = [slip.accrualEntryId, slip.paymentEntryId].filter((x): x is string => Boolean(x));
        if (entryIds.length) await tx.journalEntry.deleteMany({ where: { id: { in: entryIds }, clientId: id, organizationId } });
        await tx.payrollUnionSlip.delete({ where: { id: slip.id } });
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "payroll.union_slip_delete", targetType: "Client", targetId: id, metadata: { union: slip.union } });
    });
    return NextResponse.json({ deleted: true });
});
