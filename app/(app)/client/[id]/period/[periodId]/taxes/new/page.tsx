import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatPeriodLabel, periodFirstDayIso, periodLastDayIso } from "@/lib/period";
import { TaxForm } from "../_components/tax-form";

export const dynamic = "force-dynamic";

// Alta de retención/percepción: OWNER / ADMIN / ACCOUNTANT (ROLES_CREATE).
// VIEWER ve el aviso de permisos; organización, cliente o período que no
// coinciden -> 404. El formulario recibe los límites de fecha del período.
export default async function NewTaxPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await requirePeriodAccess(profileId, periodId, ROLES_CREATE, { expectClientId: id });
        const period = await prisma.period.findFirst({ where: { id: periodId, organizationId }, select: { month: true, year: true } });
        if (!period) throw new NotFoundError();
        return period;
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const period = guard.data;

    return (
        <TaxForm
            clientId={id}
            periodId={periodId}
            periodLabel={formatPeriodLabel(period)}
            dateMin={periodFirstDayIso(period)}
            dateMax={periodLastDayIso(period)}
            initial={{ date: "", type: "RETENCION IVA", amount: "", description: "" }}
        />
    );
}
