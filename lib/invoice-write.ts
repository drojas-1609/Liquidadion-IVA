import "server-only";
import type { Prisma } from "@prisma/client";
import prisma from "./prisma";
import type { InvoiceV2Data } from "./api-input";
import { resolveManualInvoice, type ManualInvoiceData } from "./manual-invoice";
import { clientConditionCode } from "./client-condition";
import { TURIVA_NOT_INCLUDED_MESSAGE, type InvoiceModelData } from "./invoice-model";
import {
    checkVoucherDate,
    duplicateVoucherMessage,
    duplicateVoucherWhere,
    type DuplicateVoucherWhere,
    type InvoiceWarning,
} from "./invoice-rules";
import { ConflictError, NotFoundError, ValidationError } from "./auth/errors";

/**
 * Escritura de comprobantes manuales (contrato v2) compartida por el alta y,
 * más adelante, la edición. Única fuente de:
 *  - la preparación autorizada: mes/año del período, fecha frente al período,
 *    condición fiscal del cliente leída de la base, matriz normativa,
 *    documento, modelo contable y clave de duplicidad;
 *  - la verificación TurIVA bajo el bloqueo del Period (tomado por la ruta);
 *  - los datos que se escriben en Invoice y sus líneas de IVA.
 *
 * Las funciones lanzan los mismos errores que la ruta (404 / 422 / 409).
 * Toda lectura filtra por organizationId.
 */

export interface ManualInvoicePlan {
    /** Advertencias de la fecha (compra de un período anterior). */
    warnings: InvoiceWarning[];
    resolved: ManualInvoiceData;
    /** Clave de duplicidad global del cliente (misma que los índices únicos parciales). */
    duplicateWhere: DuplicateVoucherWhere;
}

/**
 * Prepara un comprobante manual para escribir. `periodId` y `clientId` vienen
 * del acceso ya autorizado al período; `excludeInvoiceId` excluye al propio
 * comprobante de la duplicidad (edición).
 */
export async function prepareManualInvoice(args: {
    organizationId: string;
    periodId: string;
    clientId: string;
    input: InvoiceV2Data;
    excludeInvoiceId?: string;
}): Promise<ManualInvoicePlan> {
    const { organizationId, periodId, clientId, input } = args;

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
    const { model } = resolved.data;

    // Duplicidad entre TODOS los períodos del cliente, con la misma clave que
    // los índices únicos parciales.
    const duplicateWhere = duplicateVoucherWhere(
        {
            organizationId,
            clientId,
            category: input.category,
            voucherCode: model.voucherCode,
            pointOfSale: input.pointOfSale,
            number: input.number,
            counterpartyDocType: model.counterpartyDocType,
            counterpartyDocNumber: model.counterpartyDocNumber,
        },
        args.excludeInvoiceId,
    );

    return { warnings: dateCheck.warnings, resolved: resolved.data, duplicateWhere };
}

/** Período (mes/año) donde ya existe el comprobante duplicado, o null. */
export async function findDuplicateVoucherPeriod(where: DuplicateVoucherWhere): Promise<{ month: number; year: number } | null> {
    const dup = await prisma.invoice.findFirst({
        where,
        select: { period: { select: { month: true, year: true } } },
    });
    return dup?.period ?? null;
}

/**
 * 409 con el período donde ya está cargado (mismo cliente y organización: sin
 * datos ajenos).
 */
export async function assertNoDuplicateVoucher(where: DuplicateVoucherWhere): Promise<void> {
    const existing = await findDuplicateVoucherPeriod(where);
    if (existing) throw new ConflictError(duplicateVoucherMessage(existing));
}

/**
 * Comprobantes 195–197: relee la inclusión en el Régimen TurIVA dentro de la
 * transacción. Sin inclusión -> 422.
 *
 * PRECONDICIÓN: el llamador YA bloqueó el período con `lockPeriodForWrite`
 * (lib/period-lock) en esta misma transacción, como primera operación. Este
 * helper NO bloquea: así se respeta el orden único Period -> Invoice y no hay
 * un segundo bloqueo del período.
 */
export async function assertTurivaIncludedUnderLock(
    tx: Prisma.TransactionClient,
    periodId: string,
    organizationId: string,
): Promise<void> {
    const settings = await tx.periodVatSettings.findUnique({
        where: { periodId_organizationId: { periodId, organizationId } },
        select: { turivaIncluded: true },
    });
    if (settings?.turivaIncluded !== true) {
        throw new ValidationError(TURIVA_NOT_INCLUDED_MESSAGE, "turivaRelationCode");
    }
}

/**
 * Columnas de Invoice que se escriben para un comprobante manual (sin autoría
 * ni líneas). Importes ya recalculados en el servidor: columnas heredadas (con
 * signo, compatibilidad con el código anterior) Y modelo contable (positivo,
 * signo por código oficial).
 */
export function manualInvoiceColumns(args: {
    input: InvoiceV2Data;
    resolved: ManualInvoiceData;
    periodId: string;
    organizationId: string;
    clientId: string;
}) {
    const { input, resolved, periodId, organizationId, clientId } = args;
    const { model, legacy } = resolved;
    return {
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
        source: "MANUAL" as const,
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
        counterpartyVatConditionCode: resolved.counterpartyVatConditionCode,
        turivaRelationCode: resolved.turivaRelationCode,
        voucherVariant: resolved.voucherVariant,
    };
}

/** Líneas de IVA del modelo, listas para `vatLines: { create }`. */
export function manualInvoiceVatLines(model: InvoiceModelData) {
    return model.vatLines.map((l) => ({
        vatRateCode: l.vatRateCode,
        netAmount: l.netAmount,
        vatAmount: l.vatAmount,
        creditAllocation: l.creditAllocation,
        computableVatAmount: l.computableVatAmount,
        computableOverridden: l.computableOverridden,
    }));
}
