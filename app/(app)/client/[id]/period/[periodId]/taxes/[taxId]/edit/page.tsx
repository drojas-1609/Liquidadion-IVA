import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { serializeTaxRecord } from "@/lib/serializers";
import { isTaxRecordType } from "@/lib/tax-types";
import { formatPeriodLabel, periodFirstDayIso, periodLastDayIso } from "@/lib/period";
import { TaxForm } from "../../_components/tax-form";

export const dynamic = "force-dynamic";

// Edición de retención/percepción: OWNER / ADMIN / ACCOUNTANT (ROLES_UPDATE).
// VIEWER ve el aviso de permisos; organización, cliente, período o registro
// que no coinciden -> 404 (sin revelar cuál). El período no se cambia: el
// formulario sólo ofrece fechas del período del registro. Un tipo histórico
// fuera del catálogo se muestra marcado y hay que elegir uno válido.
export default async function EditTaxPage({ params }: { params: Promise<{ id: string; periodId: string; taxId: string }> }) {
    const { id, periodId, taxId } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await requirePeriodAccess(profileId, periodId, ROLES_UPDATE, { expectClientId: id });
        const period = await prisma.period.findFirst({ where: { id: periodId, organizationId }, select: { month: true, year: true } });
        if (!period) throw new NotFoundError();
        const tax = await prisma.taxRecord.findFirst({ where: { id: taxId, periodId, organizationId } });
        if (!tax) throw new NotFoundError();
        return { period, tax: serializeTaxRecord(tax) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { period, tax } = guard.data;

    const known = isTaxRecordType(tax.type);
    return (
        // key: un updatedAt nuevo (p. ej. tras "Recargar") remonta el formulario con los datos actuales.
        <TaxForm
            key={tax.updatedAt}
            clientId={id}
            periodId={periodId}
            periodLabel={formatPeriodLabel(period)}
            dateMin={periodFirstDayIso(period)}
            dateMax={periodLastDayIso(period)}
            // `date` del DTO es la medianoche UTC del día: los primeros 10 caracteres son el día UTC.
            initial={{ date: tax.date.slice(0, 10), type: known ? tax.type : "", amount: tax.amount, description: tax.description ?? "" }}
            edit={{ taxId: tax.id, updatedAt: tax.updatedAt, unknownType: known ? null : tax.type }}
        />
    );
}
