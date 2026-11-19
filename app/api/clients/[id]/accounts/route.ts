import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { buildAccountCreate, parentCode } from "@/lib/accounting/chart-input";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/clients/[id]/accounts — alta de una cuenta en el plan del cliente.
// El rubro o capítulo padre debe existir; un uso automático que ya tenía otra
// cuenta pasa a la nueva. P2002 (código repetido) -> 409.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const parsed = buildAccountCreate(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const a = parsed.value;
    const created = await prisma.$transaction(async (tx) => {
        const parent = parentCode(a.code);
        if (parent && !(await tx.chartAccount.findFirst({ where: { clientId: id, organizationId, code: parent }, select: { id: true } }))) {
            throw new ValidationError(`primero creá el ${parent.length === 1 ? "capítulo" : "rubro"} ${parent}`, "code");
        }
        if (a.role) await tx.chartAccount.updateMany({ where: { clientId: id, organizationId, role: a.role }, data: { role: null, updatedById: profileId } });
        const row = await tx.chartAccount.create({ data: { ...a, organizationId, clientId: id, createdById: profileId, updatedById: profileId } });
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "chart.account_create", targetType: "Client", targetId: id, metadata: { code: a.code, role: a.role } });
        return row;
    });
    return NextResponse.json({ id: created.id, code: created.code }, { status: 201 });
});
