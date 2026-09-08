import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildPeriodInput } from "@/lib/api-input";
import { serializePeriod } from "@/lib/serializers";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requireClientAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { ValidationError } from "@/lib/auth/errors";

// POST /api/periods — alta de período para un cliente de la organización activa.
//
// Orden (brief §7.1): auth -> organización -> rol (crear no depende del recurso)
// -> parseo -> validación semántica -> acceso al Client (404 si es de otra org
// o no existe) -> escritura + AuditLog en una transacción.
export const POST = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const body = await parseJsonBody(request);
    const parsed = buildPeriodInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    await requireClientAccess(profileId, parsed.data.clientId, ROLES_CREATE);

    const created = await prisma.$transaction(async (tx) => {
        const period = await tx.period.create({
            data: {
                clientId: parsed.data.clientId,
                organizationId,
                month: parsed.data.month,
                year: parsed.data.year,
                createdById: profileId,
                updatedById: profileId,
            },
        });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "period.create",
            targetType: "Period",
            targetId: period.id,
            metadata: {
                clientId: parsed.data.clientId,
                month: parsed.data.month,
                year: parsed.data.year,
            },
        });
        return period;
    });

    // P2002 sobre @@unique([month, year, clientId]) -> withApiAuthz -> 409 CONFLICT.
    return NextResponse.json(serializePeriod(created), { status: 201 });
});
