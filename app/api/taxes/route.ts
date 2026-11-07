import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildTaxInput, isDateInPeriod } from "@/lib/api-input";
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
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { assertTaxIdentityFree } from "@/lib/tax-identity";
import { assertPerceptionLink } from "@/lib/tax-record-link";
import { formatPeriodLabel } from "@/lib/period";

// POST /api/taxes — alta de retención/percepción en un período de la
// organización activa. Mismo orden y garantías que /api/invoices.
//
// Orden: auth -> organización -> rol -> parseo -> acceso al Period (404 si es
// de otra org o no existe) -> aislamiento: el período debe ser de la
// organización ACTIVA (si no, el MISMO 404, antes de abrir la transacción y
// sin bloquear nada) -> transacción: bloqueo de la fila Period
// (lockPeriodForWrite, primera operación; período desaparecido -> 404) ->
// relectura del Period bajo el bloqueo -> fecha dentro del mes/año del período
// (422 date) -> percepción vinculada a una compra del período con el mismo
// importe (422; vínculo repetido: 409 por el índice único) -> identidad del
// F.2051 libre en TODOS los períodos del cliente, bajo el bloqueo por cliente
// (409) -> TaxRecord + AuditLog.
export const POST = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const body = await parseJsonBody(request);
    const parsed = buildTaxInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    const access = await requirePeriodAccess(profileId, parsed.data.periodId, ROLES_CREATE);
    // Aislamiento: un período de OTRA organización del mismo usuario responde
    // igual que uno inexistente (sin revelar su existencia).
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const created = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, parsed.data.periodId, organizationId);
        const period = await tx.period.findFirst({
            where: { id: parsed.data.periodId, organizationId },
            select: { month: true, year: true, clientId: true },
        });
        if (!period) throw new NotFoundError();
        if (!isDateInPeriod(parsed.data.date, period)) {
            throw new ValidationError(`la fecha debe pertenecer al período ${formatPeriodLabel(period)}`, "date");
        }
        await assertPerceptionLink(tx, { periodId: parsed.data.periodId, organizationId }, parsed.data, parsed.data.amount);
        await assertTaxIdentityFree(tx, { organizationId, clientId: period.clientId }, parsed.data);
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
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json(serializeTaxRecord(created), { status: 201 });
});
