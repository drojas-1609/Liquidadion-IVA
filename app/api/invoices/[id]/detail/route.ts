import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { lockInvoiceForUpdate } from "@/lib/invoice-lock";
import { assertTurivaIncludedUnderLock } from "@/lib/invoice-write";
import { INVOICE_NOT_EDITABLE_MESSAGES, detailedEditability } from "@/lib/invoice-edit";
import {
    DETAILED_AMOUNT_FIELDS,
    buildDetailedModel,
    detailedChangedFields,
    parseDetailedEditBody,
    type DetailedCurrent,
} from "@/lib/invoice-detail-edit";
import { DEFAULT_PERIOD_VAT_SETTINGS, legacyColumnsFor } from "@/lib/invoice-model";
import { D } from "@/lib/decimal";
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
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

const STALE_MESSAGE = "El comprobante fue modificado por otra persona. Volvé a abrirlo para ver los datos actuales.";

/** Fila completa del comprobante (todas las columnas del modelo y sus líneas). */
const FULL_SELECT = {
    id: true, periodId: true, clientId: true, category: true, source: true, voucherCode: true, voucherDate: true, pointOfSale: true, number: true,
    counterpartyDocType: true, counterpartyDocNumber: true, counterpartyName: true, counterpartyVatConditionCode: true, currencyCode: true,
    exchangeRate: true, lidSection: true, operationCode: true, taxedNetAmount: true, totalVatAmount: true, voucherTotalAmount: true,
    reportedComputableVatCreditAmount: true, netWithoutVatBreakdownAmount: true, nonTaxedAmount: true, exemptAmount: true,
    vatPerceptionAmount: true, nationalPerceptionAmount: true, iibbPerceptionAmount: true, municipalPerceptionAmount: true,
    internalTaxesAmount: true, otherTaxesAmount: true, turivaRefundAmount: true,
    vatLines: { select: { vatRateCode: true, netAmount: true, vatAmount: true, creditAllocation: true, computableVatAmount: true } },
} as const;

const notEditable = (reason: keyof typeof INVOICE_NOT_EDITABLE_MESSAGES) =>
    new ValidationError(reason === "MULTI_RATE" ? "Sólo los comprobantes importados se corrigen con el formulario detallado." : INVOICE_NOT_EDITABLE_MESSAGES[reason], "invoice");

// PATCH /api/invoices/[id]/detail — corrección DETALLADA de un comprobante
// IMPORTADO (ROLES_UPDATE: OWNER / ADMIN / ACCOUNTANT / OPERATOR). Conserva la
// procedencia (source IMPORT) y todo lo que no se edita (identidad,
// clasificaciones). Reglas: lib/invoice-detail-edit.
//
// Orden: auth -> organización -> rol -> parseo (422) -> comprobante por id +
// organización (404) -> acceso al período (404) -> editabilidad detallada
// (422) -> transacción: lock Period (lockPeriodForWrite: PERIOD_CLOSED /
// PERIOD_BUSY) -> lock Invoice -> updatedAt exacto (409) -> mismo período y
// cliente (409) -> relectura completa y editabilidad sobre la fila bloqueada ->
// configuración del período (prorrateo, TurIVA) -> modelo con las reglas de la
// importación (422) -> percepción vinculada coherente (409) -> sin cambios: 200
// sin escritura ni AuditLog -> update + líneas + AuditLog invoice.update
// (nombres de campo, nunca valores).
export const PATCH = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);

    const parsed = parseDetailedEditBody(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const input = parsed.data;

    const current = await prisma.invoice.findFirst({ where: { id, organizationId }, select: FULL_SELECT });
    if (!current) throw new NotFoundError();
    const access = await requirePeriodAccess(profileId, current.periodId, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const periodId = access.period.id;
    const clientId = access.period.clientId;
    const pre = detailedEditability(current);
    if (!pre.ok) throw notEditable(pre.reason);

    const result = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, periodId, organizationId);
        const locked = await lockInvoiceForUpdate(tx, id, organizationId);
        if (!locked) throw new NotFoundError();
        if (locked.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) throw new ConflictError(STALE_MESSAGE);
        if (locked.periodId !== periodId || locked.clientId !== clientId) throw new ConflictError(STALE_MESSAGE);

        const row = await tx.invoice.findFirst({ where: { id, organizationId }, select: FULL_SELECT });
        if (!row) throw new NotFoundError();
        const editable = detailedEditability(row);
        if (!editable.ok) throw notEditable(editable.reason);

        const period = await tx.period.findFirst({ where: { id: periodId, organizationId }, select: { month: true, year: true } });
        if (!period) throw new NotFoundError();
        const settings = await tx.periodVatSettings.findUnique({
            where: { periodId_organizationId: { periodId, organizationId } },
            select: { creditProrationMode: true, globalCoefficient: true, turivaIncluded: true },
        });
        if (row.lidSection === "TURIVA") await assertTurivaIncludedUnderLock(tx, periodId, organizationId);

        const built = buildDetailedModel(
            {
                category: row.category as "SALES" | "PURCHASES",
                voucherCode: row.voucherCode as number,
                pointOfSale: row.pointOfSale,
                number: row.number,
                counterpartyDocType: row.counterpartyDocType as number,
                counterpartyDocNumber: row.counterpartyDocNumber as string,
                lidSection: row.lidSection,
                currencyCode: row.currencyCode ?? "PES",
                // La importación sólo admite pesos con tipo de cambio 1.
                exchangeRate: row.exchangeRate ?? D(1),
            },
            input,
            period,
            settings ?? DEFAULT_PERIOD_VAT_SETTINGS,
        );
        if (!built.ok) throw new ValidationError(built.error, built.field);
        const { model } = built;

        // Percepción registrada a partir de este comprobante: debe seguir siendo la misma.
        const linked = await tx.taxRecord.findFirst({ where: { invoiceId: id, organizationId }, select: { amount: true } });
        if (linked && !linked.amount.equals(model.vatPerceptionAmount)) {
            throw new ConflictError(`El comprobante tiene una percepción registrada a partir de él por ${linked.amount.toFixed(2)}: corregí o desvinculá esa percepción antes de cambiar la percepción de IVA del comprobante.`);
        }

        const before: DetailedCurrent = {
            voucherDate: row.voucherDate,
            counterpartyName: row.counterpartyName,
            counterpartyVatConditionCode: row.counterpartyVatConditionCode,
            operationCode: row.operationCode,
            reportedComputableVatCreditAmount: row.reportedComputableVatCreditAmount,
            amounts: Object.fromEntries(DETAILED_AMOUNT_FIELDS.map((f) => [f, row[f]])) as DetailedCurrent["amounts"],
            vatLines: row.vatLines,
        };
        const changed = detailedChangedFields(before, input, model);
        if (changed.length === 0) {
            const unchanged = await tx.invoice.findFirst({ where: { id, organizationId } });
            if (!unchanged) throw new NotFoundError();
            return { saved: unchanged, warnings: built.warnings };
        }

        const legacy = legacyColumnsFor(model);
        const saved = await tx.invoice.update({
            where: { id_organizationId: { id, organizationId } },
            data: {
                // heredadas, derivadas del modelo
                date: legacy.date, type: legacy.type, entityName: legacy.entityName, entityCuit: legacy.entityCuit,
                netAmount: legacy.netAmount, vatRate: legacy.vatRate, vatAmount: legacy.vatAmount, totalAmount: legacy.totalAmount,
                // modelo contable (identidad, procedencia y clasificaciones sin cambios)
                voucherDate: model.voucherDate, counterpartyName: model.counterpartyName,
                counterpartyVatConditionCode: input.counterpartyVatConditionCode, operationCode: model.operationCode,
                taxedNetAmount: model.taxedNetAmount, totalVatAmount: model.totalVatAmount,
                directComputableVatCreditAmount: model.directComputableVatCreditAmount,
                reportedComputableVatCreditAmount: model.reportedComputableVatCreditAmount,
                netWithoutVatBreakdownAmount: model.netWithoutVatBreakdownAmount, nonTaxedAmount: model.nonTaxedAmount,
                exemptAmount: model.exemptAmount, vatPerceptionAmount: model.vatPerceptionAmount,
                nationalPerceptionAmount: model.nationalPerceptionAmount, iibbPerceptionAmount: model.iibbPerceptionAmount,
                municipalPerceptionAmount: model.municipalPerceptionAmount, internalTaxesAmount: model.internalTaxesAmount,
                otherTaxesAmount: model.otherTaxesAmount, grossIncomeTaxBaseAmount: model.grossIncomeTaxBaseAmount,
                voucherTotalAmount: model.voucherTotalAmount, turivaRefundAmount: model.turivaRefundAmount,
                updatedById: profileId,
                vatLines: {
                    deleteMany: {},
                    create: model.vatLines.map((l) => ({
                        vatRateCode: l.vatRateCode, netAmount: l.netAmount, vatAmount: l.vatAmount, creditAllocation: l.creditAllocation,
                        computableVatAmount: l.computableVatAmount, computableOverridden: l.computableOverridden,
                    })),
                },
            },
        });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "invoice.update",
            targetType: "Invoice",
            targetId: id,
            // Identificación (fija) y NOMBRES de los campos cambiados; nunca importes, CUIT ni nombre.
            metadata: {
                periodId: locked.periodId,
                category: locked.category,
                voucherCodeBefore: locked.voucherCode,
                voucherCodeAfter: locked.voucherCode,
                pointOfSaleBefore: locked.pointOfSale,
                pointOfSaleAfter: locked.pointOfSale,
                numberBefore: locked.number,
                numberAfter: locked.number,
                changedFields: changed.join(","),
                source: "IMPORT",
            },
        });
        return { saved, warnings: built.warnings };
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json({ ...serializeInvoice(result.saved), updatedAt: result.saved.updatedAt.toISOString(), warnings: result.warnings }, { status: 200 });
});

