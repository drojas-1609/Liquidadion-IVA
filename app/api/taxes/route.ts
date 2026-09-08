import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildTaxInput } from "@/lib/api-input";
import { serializeTaxRecord } from "@/lib/serializers";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { ValidationError } from "@/lib/auth/errors";

// POST /api/taxes — alta de retención/percepción en un período de la
// organización activa. Mismo orden y garantías que /api/invoices.
export const POST = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const body = await parseJsonBody(request);
    const parsed = buildTaxInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    await requirePeriodAccess(profileId, parsed.data.periodId, ROLES_CREATE);

    const created = await prisma.$transaction(async (tx) => {
        const taxRecord = await tx.taxRecord.create({
            data: {
                ...parsed.data,
                organizationId,
                createdById: profileId,
                updatedById: profileId,
            },
        });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "taxrecord.create",
            targetType: "TaxRecord",
            targetId: taxRecord.id,
            metadata: { periodId: parsed.data.periodId, type: parsed.data.type },
        });
        return taxRecord;
    });

    return NextResponse.json(serializeTaxRecord(created), { status: 201 });
});
