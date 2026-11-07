import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { needsZeroRateRecord } from "@/lib/vat-export/classification";
import { parseClassificationInput, PURCHASES_ONLY_FIELDS, SALES_ONLY_FIELDS } from "@/lib/vat-export/classification-input";
import type { ExportInvoice } from "@/lib/vat-export/types";
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

// PATCH /api/periods/[id]/invoice-classification — clasificaciones para la
// presentación, por lote (hasta 500 comprobantes del MISMO período).
//
// Orden: auth -> organización -> rol de edición (OWNER/ADMIN/ACCOUNTANT/
// OPERATOR) -> parseo (400/422) -> acceso al período (módulo IVA y cliente en
// el alcance; otra org o inexistente: 404) -> transacción: lockPeriodForWrite
// (409 PERIOD_CLOSED / PERIOD_BUSY) -> relectura de los comprobantes BAJO el
// bloqueo, filtrados por período y organización (si falta alguno: 404, sin
// escribir) -> reglas por categoría (las de ventas sólo en ventas, el concepto
// sólo en compras, el código de operación sólo donde hay alícuota 0 % u
// operación sin IVA, la actividad sólo si está en la ficha del cliente con
// nomenclador ARCA) -> updateMany -> AuditLog con conteo y NOMBRES de campos.
export const PATCH = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);

    const body = await parseJsonBody(request);
    const parsed = parseClassificationInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const { invoiceIds, changes, changedFields } = parsed.data;

    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const result = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const rows = await tx.invoice.findMany({
            where: { id: { in: invoiceIds }, periodId: id, organizationId },
            select: { id: true, category: true, voucherCode: true, vatLines: { select: { vatRateCode: true } } },
        });
        if (rows.length !== invoiceIds.length) throw new NotFoundError();
        const categories = new Set(rows.map((r) => r.category));
        if (SALES_ONLY_FIELDS.some((f) => f in changes) && [...categories].some((c) => c !== "SALES")) {
            throw new ValidationError("la actividad, el tipo de operación, el sujeto y la dación en pago son sólo de ventas", "changes");
        }
        if (PURCHASES_ONLY_FIELDS.some((f) => f in changes) && [...categories].some((c) => c !== "PURCHASES")) {
            throw new ValidationError("el concepto del crédito es sólo de compras", "changes");
        }
        if (rows.some((r) => r.voucherCode === null)) throw new ValidationError("hay comprobantes del modelo anterior: abrilos y guardalos antes de clasificarlos", "invoiceIds");
        if (changes.operationCode !== undefined && changes.operationCode !== null) {
            const notZero = rows.filter((r) => !needsZeroRateRecord({ category: r.category, voucherCode: r.voucherCode, vatLines: r.vatLines } as unknown as ExportInvoice));
            if (notZero.length > 0) throw new ValidationError("el código de operación sólo corresponde a operaciones al 0 % o sin IVA", "operationCode");
        }
        if (changes.activityCode) {
            const period = await tx.period.findFirst({ where: { id, organizationId }, select: { clientId: true } });
            if (!period) throw new NotFoundError();
            const act = await tx.clientActivity.findFirst({
                where: { clientId: period.clientId, organizationId, nomenclator: "ARCA", code: changes.activityCode },
                select: { id: true },
            });
            if (!act) throw new ValidationError("la actividad no figura en la ficha del cliente (nomenclador ARCA): cargala primero", "activityCode");
        }
        const updated = await tx.invoice.updateMany({
            where: { id: { in: invoiceIds }, periodId: id, organizationId },
            data: { ...changes, updatedById: profileId },
        });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "invoice.classification_change",
            targetType: "Period",
            targetId: id,
            metadata: { periodId: id, category: [...categories].sort().join(","), count: updated.count, changedFields: changedFields.join(",") },
        });
        return { count: updated.count };
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json({ periodId: id, updated: result.count }, { status: 200 });
});
