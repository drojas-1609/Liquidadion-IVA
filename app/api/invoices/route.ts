import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { buildInvoiceInputV2 } from "@/lib/api-input";
import {
    assertNoDuplicateVoucher,
    assertTurivaIncludedUnderLock,
    findDuplicateVoucherPeriod,
    manualInvoiceColumns,
    manualInvoiceVatLines,
    prepareManualInvoice,
} from "@/lib/invoice-write";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { duplicateVoucherMessage } from "@/lib/invoice-rules";
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
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

// POST /api/invoices — alta manual de comprobante (contrato v2) en un período
// de la organización activa.
//
// Orden: auth -> organización -> rol -> parseo -> forma del contrato v2 (sin
// contractVersion 2: 422, antes de tocar el período) -> acceso al Period (404
// si es de otra org o no existe) -> fecha frente al período (422) -> condición
// fiscal del cliente leída de la base -> matriz normativa -> documento de la
// contraparte -> modelo contable -> duplicidad global del cliente (409 con el
// período donde ya existe) -> transacción: bloqueo de la fila Period
// (lockPeriodForWrite, primera operación, TODOS los códigos; período
// desaparecido -> 404) -> comprobantes 195–197: relectura de la inclusión en
// el Régimen TurIVA bajo ese bloqueo -> escritura + AuditLog.
// La preparación y los datos escritos viven en lib/invoice-write.ts.
export const POST = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const body = await parseJsonBody(request);
    const parsed = buildInvoiceInputV2(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const input = parsed.data;

    const access = await requirePeriodAccess(profileId, input.periodId, ROLES_CREATE);
    // Defensa en profundidad: el período debe ser de la organización ACTIVA.
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const periodId = access.period.id;
    const clientId = access.period.clientId;

    const plan = await prepareManualInvoice({ organizationId, periodId, clientId, input });
    const { resolved } = plan;
    await assertNoDuplicateVoucher(plan.duplicateWhere);

    const created = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, periodId, organizationId);
        if (resolved.requiresTurivaSection) {
            await assertTurivaIncludedUnderLock(tx, periodId, organizationId);
        }

        const invoice = await tx.invoice.create({
            data: {
                ...manualInvoiceColumns({ input, resolved, periodId, organizationId, clientId }),
                createdById: profileId,
                updatedById: profileId,
                vatLines: { create: manualInvoiceVatLines(resolved.model) },
            },
        });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "invoice.create",
            targetType: "Invoice",
            targetId: invoice.id,
            // Sin CUIT, nombres ni importes.
            metadata: {
                periodId,
                category: input.category,
                voucherCode: resolved.model.voucherCode,
            },
        });
        return invoice;
    }).catch(async (err: unknown) => {
        // Carrera con otra alta: P2002 sobre los índices únicos parciales. Se
        // informa el período si ya es visible; si no, 409 genérico (withApiAuthz).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            const racing = await findDuplicateVoucherPeriod(plan.duplicateWhere);
            if (racing) throw new ConflictError(duplicateVoucherMessage(racing));
        }
        throw err;
    });

    return NextResponse.json(
        {
            ...serializeInvoice(created),
            warnings: plan.warnings,
            legalClass: resolved.legalClass,
            mandatoryLegend: resolved.mandatoryLegend,
            partialValidation: resolved.partialValidation,
            requiresTurivaSection: resolved.requiresTurivaSection,
        },
        { status: 201 },
    );
});
