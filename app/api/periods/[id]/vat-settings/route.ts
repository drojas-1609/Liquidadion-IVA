import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildTurivaSettingInput } from "@/lib/api-input";
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
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

const TURIVA_VOUCHER_CODES = [195, 196, 197];

const TURIVA_HAS_VOUCHERS_MESSAGE =
    "El período tiene comprobantes TurIVA (195–197): no se puede desactivar la inclusión en el Régimen TurIVA.";

// PATCH /api/periods/[id]/vat-settings — inclusión del período en el Régimen
// TurIVA (OWNER / ADMIN / ACCOUNTANT).
//
// Orden: auth -> organización -> rol -> parseo -> acceso al período (otra org o
// inexistente: MISMO 404) -> en una única transacción: bloqueo de la fila Period
// con lockPeriodForWrite (el bloqueo uniforme que usan todas las escrituras del
// contenido del período, incluidas las altas y ediciones de comprobantes
// 195–197) -> lectura de la configuración -> sin cambio: 200 sin escritura ni
// AuditLog -> desactivar con comprobantes 195–197: 409 sin escritura ni
// AuditLog -> creación o actualización de SÓLO turivaIncluded + AuditLog
// period.vat_settings_change.
// No modifica creditProrationMode ni el coeficiente global.
export const PATCH = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);

    const body = await parseJsonBody(request);
    const parsed = buildTurivaSettingInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    // Defensa en profundidad: el período debe ser de la organización ACTIVA.
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const after = parsed.data.turivaIncluded;
    const where = { periodId_organizationId: { periodId: id, organizationId } };

    await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);

        const current = await tx.periodVatSettings.findUnique({ where, select: { turivaIncluded: true } });
        const before = current?.turivaIncluded ?? false;
        if (before === after) return;

        if (!after) {
            const turivaVouchers = await tx.invoice.count({
                where: { periodId: id, organizationId, voucherCode: { in: TURIVA_VOUCHER_CODES } },
            });
            if (turivaVouchers > 0) throw new ConflictError(TURIVA_HAS_VOUCHERS_MESSAGE);
        }

        if (current) {
            await tx.periodVatSettings.update({ where, data: { turivaIncluded: after, updatedById: profileId } });
        } else {
            // El resto de los campos toma los defaults del schema.
            await tx.periodVatSettings.create({
                data: { periodId: id, organizationId, turivaIncluded: after, createdById: profileId, updatedById: profileId },
            });
        }
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "period.vat_settings_change",
            targetType: "Period",
            targetId: id,
            metadata: { changedFields: "turivaIncluded", turivaIncludedBefore: before, turivaIncludedAfter: after },
        });
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json({ periodId: id, turivaIncluded: after }, { status: 200 });
});
