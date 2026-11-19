import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { buildAccountUpdate } from "@/lib/accounting/chart-input";

type Ctx = { params: Promise<{ id: string; accountId: string }> };

// PATCH /api/clients/[id]/accounts/[accountId] — renombrar, activar/desactivar
// o asignar un uso automático (la cuenta que lo tenía lo pierde). Una cuenta
// con uso automático no se desactiva: primero se reasigna el uso.
export const PATCH = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id, accountId } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const parsed = buildAccountUpdate(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const u = parsed.value;
    await prisma.$transaction(async (tx) => {
        const acc = await tx.chartAccount.findFirst({ where: { id: accountId, clientId: id, organizationId } });
        if (!acc) throw new NotFoundError();
        if (u.role && !acc.imputable) throw new ValidationError("sólo una cuenta imputable puede tener un uso automático", "role");
        const nextRole = u.role === undefined ? acc.role : u.role;
        if (u.active === false && nextRole) throw new ValidationError("la cuenta tiene un uso automático: reasignalo antes de desactivarla", "active");
        if (u.role && u.role !== acc.role) await tx.chartAccount.updateMany({ where: { clientId: id, organizationId, role: u.role, NOT: { id: accountId } }, data: { role: null, updatedById: profileId } });
        await tx.chartAccount.update({ where: { id: accountId }, data: { ...u, updatedById: profileId } });
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "chart.account_update", targetType: "Client", targetId: id, metadata: { code: acc.code, changedFields: Object.keys(u).join(",") } });
    });
    return NextResponse.json({ ok: true });
});
