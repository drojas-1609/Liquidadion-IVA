import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { periodYearOptions } from "@/lib/period";
import { AccessNotice } from "@/app/_components/access-notice";
import { NewPeriodForm } from "./new-period-form";

export const dynamic = "force-dynamic";

// Alta de período: OWNER / ADMIN / ACCOUNTANT (ROLES_CREATE). VIEWER ve el
// aviso de permisos; cliente de otra organización o inexistente -> 404.
export default async function NewPeriodPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await requireClientAccess(profileId, id, ROLES_CREATE);
        const client = await prisma.client.findFirst({
            where: { id, organizationId },
            select: { id: true, name: true },
        });
        if (!client) throw new NotFoundError();
        return client;
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;

    // Misma regla de años (UTC) que la API, en orden descendente.
    return <NewPeriodForm clientId={guard.data.id} clientName={guard.data.name} years={periodYearOptions()} />;
}
