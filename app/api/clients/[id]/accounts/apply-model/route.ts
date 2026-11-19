import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";
import { buildApplyModel } from "@/lib/accounting/chart-input";
import { applyChartModel } from "@/lib/accounting/chart-service";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/clients/[id]/accounts/apply-model { model } — copia el plan modelo
// a un cliente que todavía no tiene plan (clientes existentes). Con plan: 409.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const parsed = buildApplyModel(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const created = await prisma.$transaction(async (tx) => {
        const n = await applyChartModel(tx, { organizationId, clientId: id, profileId }, parsed.value);
        if (n === 0) throw new ConflictError("El cliente ya tiene plan de cuentas: editalo desde esta pantalla.");
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "chart.model_apply", targetType: "Client", targetId: id, metadata: { model: parsed.value, accounts: n } });
        return n;
    });
    return NextResponse.json({ created });
});
