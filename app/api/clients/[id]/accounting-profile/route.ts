import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { validateAccountingProfile } from "@/lib/accounting/profile";
import { applyChartModel } from "@/lib/accounting/chart-service";

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/clients/[id]/accounting-profile — certificado MiPyME (categoría,
// industria, vigencia) y plan modelo. El plan modelo se copia sólo si el
// cliente todavía no tiene cuentas (si ya tiene, se informa y no se toca).
export const PUT = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const parsed = validateAccountingProfile(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const p = parsed.value;
    const result = await prisma.$transaction(async (tx) => {
        await tx.client.update({
            where: { id_organizationId: { id, organizationId } },
            data: {
                mipymeCategory: p.mipymeCategory, mipymeManufacturing: p.mipymeManufacturing,
                mipymeValidUntil: p.mipymeValidUntil ? new Date(`${p.mipymeValidUntil}T00:00:00.000Z`) : null,
                updatedById: profileId,
            },
        });
        const created = p.chartModel ? await applyChartModel(tx, { organizationId, clientId: id, profileId }, p.chartModel) : 0;
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "client.accounting_profile", targetType: "Client", targetId: id, metadata: { mipymeCategory: p.mipymeCategory, chartModel: p.chartModel, accountsCreated: created } });
        return { accountsCreated: created };
    });
    return NextResponse.json(result);
});
