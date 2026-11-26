import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, requirePeriodAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { buildCostAdjustmentInput } from "@/lib/iibb/activity-input";

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/periods/[id]/iibb-cost-adjustments { adjustments: [{ activityCode, amount, note }] }
// Ajuste manual del costo de prestadores por actividad (base por diferencia,
// criterio del estudio). Reemplaza los ajustes del período. Período cerrado: 409.
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
        const parsed = buildCostAdjustmentInput(body, codes);
        if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
        await tx.periodIibbCostAdjustment.deleteMany({ where: { periodId: id, organizationId } });
        const rows = parsed.value.adjustments;
        if (rows.length > 0) {
            await tx.periodIibbCostAdjustment.createMany({
                data: rows.map((a) => ({ organizationId, periodId: id, activityCode: a.activityCode, amount: new Prisma.Decimal(a.amount), note: a.note })),
            });
        }
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "period.iibb_cost_adjustment", targetType: "Period", targetId: id, metadata: { count: rows.length } });
        return rows.length;
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json({ ok: true, count });
});
