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
import { NotFoundError, ValidationError } from "@/lib/auth/errors";

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

    const access = await requirePeriodAccess(profileId, parsed.data.periodId, ROLES_CREATE);
    // Defensa en profundidad: el período debe ser de la organización ACTIVA.
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const { model } = parsed.data;
    const created = await prisma.$transaction(async (tx) => {
        // Importes ya recalculados en el servidor. Se escriben las columnas
        // heredadas (con signo, compatibilidad con el código anterior) Y el
        // modelo contable (positivo, signo por código oficial) + sus líneas.
        const invoice = await tx.invoice.create({
            data: {
                // heredadas
                date: parsed.data.date,
                type: parsed.data.type,
                pointOfSale: parsed.data.pointOfSale,
                number: parsed.data.number,
                entityName: parsed.data.entityName,
                entityCuit: parsed.data.entityCuit,
                netAmount: parsed.data.netAmount,
                vatRate: parsed.data.vatRate,
                vatAmount: parsed.data.vatAmount,
                totalAmount: parsed.data.totalAmount,
                category: parsed.data.category,
                periodId: parsed.data.periodId,
                organizationId,
                // modelo contable
                clientId: access.period.clientId,
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
                // TurIVA: reintegro separado del total; pestaña GENERAL en el alta actual.
                turivaRefundAmount: model.turivaRefundAmount,
                lidSection: model.lidSection,
                operationCode: model.operationCode,
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
                periodId: parsed.data.periodId,
                category: parsed.data.category,
                voucherCode: model.voucherCode,
            },
        });
        return invoice;
    });

    // P2002 sobre los índices únicos parciales de ventas/compras -> 409 CONFLICT.
    return NextResponse.json(serializeInvoice(created), { status: 201 });
});
