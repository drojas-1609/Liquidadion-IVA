import "server-only";
import prisma from "./prisma";
import { requireAuthenticatedProfile, requirePeriodAccess } from "./auth/authz";
import { ROLES_CREATE, ROLES_UPDATE } from "./auth/roles";
import { isPeriodClosed } from "./period-status";
import { NotFoundError } from "./auth/errors";
import { clientConditionCode } from "./client-condition";
import { INVOICE_NOT_EDITABLE_MESSAGES, detailedEditability, invoiceEditInitialState, invoiceEditability } from "./invoice-edit";
import { DETAILED_AMOUNT_FIELDS } from "./invoice-detail-edit";
import { voucherDisplayLabel } from "./invoice-model";
import type { ImportedInvoiceEditData } from "./imported-invoice-form";
import type { InvoiceEditFormProps } from "./invoice-form-client";

/**
 * Datos del formulario de alta de comprobantes (ventas y compras), cargados
 * con autorización: rol ROLES_CREATE sobre el período, período del cliente de
 * la URL (otro cliente, otra organización o inexistente -> 404) y toda lectura
 * filtrada por organizationId.
 *
 * Contrato mínimo hacia el cliente: sin organizationId, rol, autoría ni el
 * texto crudo de la condición fiscal (sólo su código oficial o null).
 */
export interface InvoiceFormPageData {
    clientName: string;
    period: { month: number; year: number };
    clientConditionCode: number | null;
    /** false si el período no tiene PeriodVatSettings. */
    turivaIncluded: boolean;
}

/** Período, cliente y configuración TurIVA, siempre filtrados por organización. */
async function loadFormBase(organizationId: string, clientId: string, periodId: string): Promise<InvoiceFormPageData> {
    const period = await prisma.period.findFirst({
        where: { id: periodId, organizationId },
        select: { month: true, year: true },
    });
    if (!period) throw new NotFoundError();

    const client = await prisma.client.findFirst({
        where: { id: clientId, organizationId },
        select: { name: true, condition: true },
    });
    if (!client) throw new NotFoundError();

    const settings = await prisma.periodVatSettings.findUnique({
        where: { periodId_organizationId: { periodId, organizationId } },
        select: { turivaIncluded: true },
    });

    return {
        clientName: client.name,
        period: { month: period.month, year: period.year },
        clientConditionCode: clientConditionCode(client.condition),
        turivaIncluded: settings?.turivaIncluded === true,
    };
}

/**
 * Página de alta: datos del formulario más `periodClosed` (leído sin bloqueo,
 * sólo para mostrar el aviso de período cerrado en lugar del formulario; la
 * página lo separa y NO llega al formulario).
 */
export interface InvoiceNewPageData extends InvoiceFormPageData {
    periodClosed: boolean;
}

export async function loadInvoiceFormContext(clientId: string, periodId: string): Promise<InvoiceNewPageData> {
    const { profileId } = await requireAuthenticatedProfile();
    const access = await requirePeriodAccess(profileId, periodId, ROLES_CREATE, { expectClientId: clientId });
    const base = await loadFormBase(access.organizationId, clientId, periodId);
    return { ...base, periodClosed: isPeriodClosed(access.period.status) };
}

// ── Edición ───────────────────────────────────────────────────────────────

/**
 * Edición: EDITABLE -> props mínimas del formulario (id, token updatedAt ISO y
 * valores guardados); NOT_EDITABLE -> sólo el mensaje estable de la razón (la
 * página muestra el aviso, sin formulario).
 */
export type InvoiceEditState =
    | { status: "EDITABLE"; form: InvoiceEditFormProps }
    | { status: "IMPORTED"; detail: ImportedInvoiceEditData }
    | { status: "NOT_EDITABLE"; message: string };

export interface InvoiceEditPageData extends InvoiceFormPageData {
    edit: InvoiceEditState;
    /** Ver InvoiceNewPageData.periodClosed. */
    periodClosed: boolean;
}

const EDIT_SELECT = {
    id: true,
    clientId: true,
    category: true,
    source: true,
    voucherCode: true,
    voucherDate: true,
    pointOfSale: true,
    number: true,
    counterpartyDocType: true,
    counterpartyDocNumber: true,
    counterpartyName: true,
    counterpartyVatConditionCode: true,
    voucherVariant: true,
    turivaRelationCode: true,
    taxedNetAmount: true,
    netWithoutVatBreakdownAmount: true,
    updatedAt: true,
    vatLines: { select: { vatRateCode: true } },
} as const;

/**
 * Datos de la página de edición: rol ROLES_UPDATE sobre el período del cliente
 * de la URL y comprobante de ESE período, organización y categoría. Cualquier
 * discordancia (organización, cliente, período, categoría o comprobante) ->
 * 404. Las filas heredadas sin cliente propio pertenecen al cliente de su
 * período; una fila con otro cliente -> 404.
 */
export async function loadInvoiceEditContext(
    clientId: string,
    periodId: string,
    invoiceId: string,
    direction: "SALES" | "PURCHASES",
): Promise<InvoiceEditPageData> {
    const { profileId } = await requireAuthenticatedProfile();
    const access = await requirePeriodAccess(profileId, periodId, ROLES_UPDATE, { expectClientId: clientId });
    const organizationId = access.organizationId;
    const periodClosed = isPeriodClosed(access.period.status);

    const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, organizationId, periodId, category: direction },
        select: EDIT_SELECT,
    });
    if (!invoice || (invoice.clientId !== null && invoice.clientId !== clientId)) throw new NotFoundError();

    const base = await loadFormBase(organizationId, clientId, periodId);
    if (invoice.source === "IMPORT") return { ...base, periodClosed, edit: await importedEditState(organizationId, invoice.id, periodId) };
    const row = { ...invoice, vatRateCodes: invoice.vatLines.map((l) => l.vatRateCode) };
    const editability = invoiceEditability(row);
    if (!editability.ok) {
        return { ...base, periodClosed, edit: { status: "NOT_EDITABLE", message: INVOICE_NOT_EDITABLE_MESSAGES[editability.reason] } };
    }
    return {
        ...base,
        periodClosed,
        edit: {
            status: "EDITABLE",
            form: {
                invoiceId: invoice.id,
                updatedAt: invoice.updatedAt.toISOString(),
                initial: invoiceEditInitialState(row),
                requiresCounterpartyCondition: editability.requiresCounterpartyCondition,
                requiresVoucherVariant: editability.requiresVoucherVariant,
            },
        },
    };
}

// ── Edición detallada de importados ──────────────────────────────────────

const money = (d: { toFixed(n: number): string } | null) => (d === null ? null : d.toFixed(2));

/** Fila completa del importado en la forma del formulario detallado (todo como texto, sin pérdida). */
async function importedEditState(organizationId: string, invoiceId: string, periodId: string): Promise<InvoiceEditState> {
    const r = await prisma.invoice.findFirst({
        where: { id: invoiceId, organizationId, periodId },
        include: { vatLines: { select: { vatRateCode: true, netAmount: true, vatAmount: true, creditAllocation: true, computableVatAmount: true }, orderBy: { vatRateCode: "asc" } } },
    });
    if (!r) throw new NotFoundError();
    const editable = detailedEditability(r);
    if (!editable.ok) return { status: "NOT_EDITABLE", message: INVOICE_NOT_EDITABLE_MESSAGES[editable.reason] };
    const settings = await prisma.periodVatSettings.findUnique({
        where: { periodId_organizationId: { periodId, organizationId } },
        select: { creditProrationMode: true },
    });
    return {
        status: "IMPORTED",
        detail: {
            invoiceId: r.id,
            updatedAt: r.updatedAt.toISOString(),
            category: r.category as "SALES" | "PURCHASES",
            prorationMode: settings?.creditProrationMode ?? "NONE",
            identity: {
                voucherLabel: voucherDisplayLabel(r.voucherCode as number),
                voucherCode: r.voucherCode as number,
                pointOfSale: r.pointOfSale,
                number: r.number,
                docType: r.counterpartyDocType as number,
                docNumber: r.counterpartyDocNumber ?? "",
                lidSection: r.lidSection,
                currencyCode: r.currencyCode ?? "PES",
            },
            values: {
                voucherDate: (r.voucherDate as Date).toISOString().slice(0, 10),
                counterpartyName: r.counterpartyName ?? "",
                counterpartyVatConditionCode: r.counterpartyVatConditionCode,
                operationCode: r.operationCode,
                amounts: Object.fromEntries(DETAILED_AMOUNT_FIELDS.map((f) => [f, money(r[f]) ?? "0.00"])) as ImportedInvoiceEditData["values"]["amounts"],
                reportedComputableVatCreditAmount: money(r.reportedComputableVatCreditAmount),
                vatLines: r.vatLines.map((l) => ({
                    vatRateCode: l.vatRateCode,
                    netAmount: l.netAmount.toFixed(2),
                    vatAmount: l.vatAmount.toFixed(2),
                    creditAllocation: l.creditAllocation,
                    computableVatAmount: money(l.computableVatAmount),
                })),
            },
            classifications: {
                activityCode: r.activityCode,
                saleOperationType: r.saleOperationType,
                buyerType: r.buyerType,
                purchaseCreditConcept: r.purchaseCreditConcept,
                dationInPayment: r.dationInPayment,
            },
            totals: { taxedNet: r.taxedNetAmount?.toFixed(2) ?? "0.00", vat: r.totalVatAmount?.toFixed(2) ?? "0.00", total: r.voucherTotalAmount?.toFixed(2) ?? "0.00" },
        },
    };
}
