import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { buildInvoiceInputV2 } from "@/lib/api-input";
import { resolveManualInvoice } from "@/lib/manual-invoice";
import { clientConditionCode } from "@/lib/client-condition";
import { TURIVA_NOT_INCLUDED_MESSAGE } from "@/lib/invoice-model";
import { lockPeriodForUpdate } from "@/lib/period-lock";
import { checkVoucherDate, duplicateVoucherMessage, duplicateVoucherWhere } from "@/lib/invoice-rules";
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
// período donde ya existe) -> escritura + AuditLog en una transacción.
// Comprobantes 195–197: dentro de esa MISMA transacción se bloquea la fila
// Period (mismo helper que PATCH /api/periods/[id]/vat-settings) y se relee
// la inclusión en el Régimen TurIVA antes de escribir.
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

    // Mes y año del período (requirePeriodAccess sólo trae id/cliente/organización).
    const period = await prisma.period.findFirst({
        where: { id: periodId, organizationId },
        select: { month: true, year: true },
    });
    if (!period) throw new NotFoundError();

    const dateCheck = checkVoucherDate(input.category, input.date, period);
    if (!dateCheck.ok) throw new ValidationError(dateCheck.error, dateCheck.field);

    // Condición fiscal del cliente: SIEMPRE de la base, nunca del body.
    const client = await prisma.client.findFirst({
        where: { id: clientId, organizationId },
        select: { condition: true },
    });
    if (!client) throw new NotFoundError();

    const resolved = resolveManualInvoice(input, clientConditionCode(client.condition));
    if (!resolved.ok) throw new ValidationError(resolved.error, resolved.field, { pending: resolved.pending });
    const { model, legacy } = resolved.data;

    // Duplicidad entre TODOS los períodos del cliente, con la misma clave que
    // los índices únicos parciales. El 409 sólo identifica el período propio
    // donde ya está cargado (mismo cliente y organización: sin datos ajenos).
    const duplicateWhere = duplicateVoucherWhere({
        organizationId,
        clientId,
        category: input.category,
        voucherCode: model.voucherCode,
        pointOfSale: input.pointOfSale,
        number: input.number,
        counterpartyDocType: model.counterpartyDocType,
        counterpartyDocNumber: model.counterpartyDocNumber,
    });
    const findDuplicatePeriod = async () => {
        const dup = await prisma.invoice.findFirst({
            where: duplicateWhere,
            select: { period: { select: { month: true, year: true } } },
        });
        return dup?.period ?? null;
    };
    const existing = await findDuplicatePeriod();
    if (existing) throw new ConflictError(duplicateVoucherMessage(existing));

    const created = await prisma.$transaction(async (tx) => {
        if (resolved.data.requiresTurivaSection) {
            // Serializa con el cambio de inclusión TurIVA del período: la
            // lectura posterior ve el valor vigente al momento de escribir.
            await lockPeriodForUpdate(tx, periodId, organizationId);
            const settings = await tx.periodVatSettings.findUnique({
                where: { periodId_organizationId: { periodId, organizationId } },
                select: { turivaIncluded: true },
            });
            if (settings?.turivaIncluded !== true) {
                throw new ValidationError(TURIVA_NOT_INCLUDED_MESSAGE, "turivaRelationCode");
            }
        }

        // Importes ya recalculados en el servidor. Se escriben las columnas
        // heredadas (con signo, compatibilidad con el código anterior) Y el
        // modelo contable (positivo, signo por código oficial) + sus líneas.
        const invoice = await tx.invoice.create({
            data: {
                // heredadas (derivadas del modelo)
                date: legacy.date,
                type: legacy.type,
                pointOfSale: input.pointOfSale,
                number: input.number,
                entityName: legacy.entityName,
                entityCuit: legacy.entityCuit,
                netAmount: legacy.netAmount,
                vatRate: legacy.vatRate,
                vatAmount: legacy.vatAmount,
                totalAmount: legacy.totalAmount,
                category: input.category,
                periodId,
                organizationId,
                // modelo contable
                clientId,
                source: "MANUAL",
                voucherCode: model.voucherCode,
                voucherDate: model.voucherDate,
                counterpartyDocType: model.counterpartyDocType,
                counterpartyDocNumber: model.counterpartyDocNumber,
                counterpartyName: model.counterpartyName,
                currencyCode: model.currencyCode,
                exchangeRate: model.exchangeRate,
                taxedNetAmount: model.taxedNetAmount,
                totalVatAmount: model.totalVatAmount,
                directComputableVatCreditAmount: model.directComputableVatCreditAmount,
                reportedComputableVatCreditAmount: model.reportedComputableVatCreditAmount,
                netWithoutVatBreakdownAmount: model.netWithoutVatBreakdownAmount,
                nonTaxedAmount: model.nonTaxedAmount,
                exemptAmount: model.exemptAmount,
                vatPerceptionAmount: model.vatPerceptionAmount,
                nationalPerceptionAmount: model.nationalPerceptionAmount,
                iibbPerceptionAmount: model.iibbPerceptionAmount,
                municipalPerceptionAmount: model.municipalPerceptionAmount,
                internalTaxesAmount: model.internalTaxesAmount,
                otherTaxesAmount: model.otherTaxesAmount,
                grossIncomeTaxBaseAmount: model.grossIncomeTaxBaseAmount,
                voucherTotalAmount: model.voucherTotalAmount,
                // TurIVA: reintegro separado del total; pestaña derivada del código.
                turivaRefundAmount: model.turivaRefundAmount,
                lidSection: model.lidSection,
                operationCode: model.operationCode,
                // PR B (expand): contraparte, relación TurIVA y variante
                counterpartyVatConditionCode: resolved.data.counterpartyVatConditionCode,
                turivaRelationCode: resolved.data.turivaRelationCode,
                voucherVariant: resolved.data.voucherVariant,
                createdById: profileId,
                updatedById: profileId,
                vatLines: {
                    create: model.vatLines.map((l) => ({
                        vatRateCode: l.vatRateCode,
                        netAmount: l.netAmount,
                        vatAmount: l.vatAmount,
                        creditAllocation: l.creditAllocation,
                        computableVatAmount: l.computableVatAmount,
                        computableOverridden: l.computableOverridden,
                    })),
                },
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
                voucherCode: model.voucherCode,
            },
        });
        return invoice;
    }).catch(async (err: unknown) => {
        // Carrera con otra alta: P2002 sobre los índices únicos parciales. Se
        // informa el período si ya es visible; si no, 409 genérico (withApiAuthz).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            const racing = await findDuplicatePeriod();
            if (racing) throw new ConflictError(duplicateVoucherMessage(racing));
        }
        throw err;
    });

    return NextResponse.json(
        {
            ...serializeInvoice(created),
            warnings: dateCheck.warnings,
            legalClass: resolved.data.legalClass,
            mandatoryLegend: resolved.data.mandatoryLegend,
            partialValidation: resolved.data.partialValidation,
            requiresTurivaSection: resolved.data.requiresTurivaSection,
        },
        { status: 201 },
    );
});
