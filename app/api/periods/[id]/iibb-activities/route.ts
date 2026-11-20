import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, requirePeriodAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { buildActivityAssignmentInput } from "@/lib/iibb/activity-input";

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/periods/[id]/iibb-activities { assignments: [{ invoiceId, code|null }] }
// Corrección manual de la actividad de IIBB de ventas del período (null = volver
// a la del punto de venta o la principal). Período cerrado: 409.
export const PUT = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);
    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const body = await parseJsonBody(request);

    const count = await prisma.$transaction(async (tx) => {
            await lockPeriodForWrite(tx, id, organizationId);
            const codes = (await tx.clientActivity.findMany({ where: { clientId: access.period.clientId, organizationId }, select: { code: true } })).map((a) => a.code);
            const parsed = buildActivityAssignmentInput(body, codes);
            if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
            const byCode = new Map<string | null, string[]>();
            for (const a of parsed.value.assignments) byCode.set(a.code, [...(byCode.get(a.code) ?? []), a.invoiceId]);
            let n = 0;
            for (const [code, ids] of byCode) {
                n += (await tx.invoice.updateMany({ where: { id: { in: ids }, periodId: id, organizationId, category: "SALES" }, data: { iibbActivityCode: code } })).count;
            }
            if (n !== parsed.value.assignments.length) throw new ValidationError("Algún comprobante no es una venta de este período.", "assignments");
            await recordAudit(tx, {
                organizationId,
                actorProfileId: profileId,
                action: "invoice.iibb_activity",
                targetType: "Period",
                targetId: id,
                metadata: { count: n, periodId: id, code: byCode.size === 1 ? [...byCode.keys()][0] : null },
            });
            return n;
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json({ updated: count });
});
