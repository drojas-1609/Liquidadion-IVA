import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildIibbPositionInput, iibbPositionChangedFields } from "@/lib/iibb-position-input";
import { lockPeriodForWrite } from "@/lib/period-lock";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/periods/[id]/iibb-position — datos de la DDJJ de IIBB que carga el
// estudio (saldo a favor anterior, pagos a cuenta, otros créditos/débitos y la
// DDJJ presentada). Mismo orden que vat-position: auth -> organización -> rol ->
// parseo -> acceso al período (MISMO 404) -> transacción: lockPeriodForWrite
// (cerrado: 409) -> lectura -> sin cambios: 200 sin escritura -> upsert +
// AuditLog period.iibb_position_change (sólo nombres de campo, nunca importes).
export const PUT = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);

    const parsed = buildIibbPositionInput(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const next = parsed.data;
    const where = { periodId_organizationId: { periodId: id, organizationId } };

    const changed = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const current = await tx.periodIibbPosition.findUnique({
            where,
            select: {
                previousBalance: true, paymentsOnAccount: true, otherCredits: true, otherDebits: true, reference: true,
                filedVerifier: true, filedDate: true, filedTaxAmount: true, filedDeductionsAmount: true, filedBalanceDgr: true, filedBalanceTaxpayer: true,
            },
        });
        const fields = iibbPositionChangedFields(current, next);
        if (fields.length === 0) return false;
        if (current) {
            await tx.periodIibbPosition.update({ where, data: { ...next, updatedById: profileId } });
        } else {
            await tx.periodIibbPosition.create({ data: { ...next, periodId: id, organizationId, createdById: profileId, updatedById: profileId } });
        }
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "period.iibb_position_change",
            targetType: "Period",
            targetId: id,
            metadata: { changedFields: fields.join(",") },
        });
        return true;
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json({ periodId: id, changed }, { status: 200 });
});
