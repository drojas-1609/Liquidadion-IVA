import "server-only";
import prisma from "./prisma";
import { requireAuthenticatedProfile, requirePeriodAccess } from "./auth/authz";
import { ROLES_CREATE } from "./auth/roles";
import { NotFoundError } from "./auth/errors";
import { clientConditionCode } from "./client-condition";

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

export async function loadInvoiceFormContext(clientId: string, periodId: string): Promise<InvoiceFormPageData> {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await requirePeriodAccess(profileId, periodId, ROLES_CREATE, { expectClientId: clientId });

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
