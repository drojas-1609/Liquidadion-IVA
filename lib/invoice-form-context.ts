import "server-only";
import prisma from "./prisma";
import { requireAuthenticatedProfile, requirePeriodAccess } from "./auth/authz";
import { ROLES_CREATE, ROLES_UPDATE } from "./auth/roles";
import { NotFoundError } from "./auth/errors";
import { clientConditionCode } from "./client-condition";
import { INVOICE_NOT_EDITABLE_MESSAGES, invoiceEditInitialState, invoiceEditability } from "./invoice-edit";
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

export async function loadInvoiceFormContext(clientId: string, periodId: string): Promise<InvoiceFormPageData> {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await requirePeriodAccess(profileId, periodId, ROLES_CREATE, { expectClientId: clientId });
    return loadFormBase(organizationId, clientId, periodId);
}

// ── Edición ───────────────────────────────────────────────────────────────

/**
 * Edición: EDITABLE -> props mínimas del formulario (id, token updatedAt ISO y
 * valores guardados); NOT_EDITABLE -> sólo el mensaje estable de la razón (la
 * página muestra el aviso, sin formulario).
 */
export type InvoiceEditState =
    | { status: "EDITABLE"; form: InvoiceEditFormProps }
    | { status: "NOT_EDITABLE"; message: string };

export interface InvoiceEditPageData extends InvoiceFormPageData {
    edit: InvoiceEditState;
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
    const { organizationId } = await requirePeriodAccess(profileId, periodId, ROLES_UPDATE, { expectClientId: clientId });

    const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, organizationId, periodId, category: direction },
        select: EDIT_SELECT,
    });
    if (!invoice || (invoice.clientId !== null && invoice.clientId !== clientId)) throw new NotFoundError();

    const base = await loadFormBase(organizationId, clientId, periodId);
    const row = { ...invoice, vatRateCodes: invoice.vatLines.map((l) => l.vatRateCode) };
    const editability = invoiceEditability(row);
    if (!editability.ok) {
        return { ...base, edit: { status: "NOT_EDITABLE", message: INVOICE_NOT_EDITABLE_MESSAGES[editability.reason] } };
    }
    return {
        ...base,
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
