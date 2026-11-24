import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { buildGrossIncomeInput } from "@/lib/iibb/activity-input";
import { currentFiscalYear } from "@/lib/iibb/rate-years";

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/clients/[id]/gross-income { incomeYear, amount|null, note }
// Ingresos brutos anuales del cliente (todas las actividades y jurisdicciones),
// cargados por el estudio: definen el tramo de alícuota del año siguiente.
export const PUT = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const parsed = buildGrossIncomeInput(await parseJsonBody(request), currentFiscalYear());
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const { incomeYear, amount, note } = parsed.value;

    await prisma.$transaction(async (tx) => {
        const client = await tx.client.findFirst({ where: { id, organizationId }, select: { id: true } });
        if (!client) throw new NotFoundError();
        if (amount === null) {
            await tx.clientGrossIncomeYear.deleteMany({ where: { clientId: id, organizationId, incomeYear } });
        } else {
            await tx.clientGrossIncomeYear.upsert({
                where: { clientId_incomeYear: { clientId: id, incomeYear } },
                create: { organizationId, clientId: id, incomeYear, amount, note, updatedById: profileId },
                update: { amount, note, updatedById: profileId },
            });
        }
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "client.gross_income_year", targetType: "Client", targetId: id, metadata: { incomeYear, cleared: amount === null } });
    });
    return NextResponse.json({ ok: true });
});
