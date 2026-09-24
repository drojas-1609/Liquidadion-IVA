import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildInvoiceInput } from "@/lib/api-input";
import { serializeInvoice } from "@/lib/serializers";
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

// POST /api/invoices — alta de comprobante en un período de la organización activa.
//
// Orden (brief §7.1): auth -> organización -> rol -> parseo -> validación
// (recalcula vatAmount/totalAmount en el servidor) -> acceso al Period (404 si
// es de otra org o no existe) -> escritura + AuditLog en una transacción.
export const POST = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const body = await parseJsonBody(request);
    const parsed = buildInvoiceInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    await requirePeriodAccess(profileId, parsed.data.periodId, ROLES_CREATE);

    const created = await prisma.$transaction(async (tx) => {
        // vatAmount y totalAmount ya vienen recalculados por buildInvoiceInput.
        const invoice = await tx.invoice.create({
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
            action: "invoice.create",
            targetType: "Invoice",
            targetId: invoice.id,
            metadata: {
                periodId: parsed.data.periodId,
                category: parsed.data.category,
                type: parsed.data.type,
            },
        });
        return invoice;
    });

    return NextResponse.json(serializeInvoice(created), { status: 201 });
});
