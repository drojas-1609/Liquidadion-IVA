import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_CLIENT_MANAGE } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { loadIibbProfile } from "@/lib/client-iibb-store";
import { ClientProfileForm } from "../../../clients/_components/client-profile-form";

export const dynamic = "force-dynamic";

// Edición de cliente: sólo OWNER / ADMIN. Otra organización o inexistente -> 404.
export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await requireClientAccess(profileId, id, ROLES_CLIENT_MANAGE);
        // Orden obligatorio: primero la versión (Client.updatedAt) y DESPUÉS la
        // ficha IIBB. Toda escritura de la ficha avanza la versión en la misma
        // transacción, así que una ficha más nueva que la versión leída sólo
        // puede producir un 409 al guardar, nunca aceptar datos viejos.
        const client = await prisma.client.findFirst({ where: { id, organizationId } });
        if (!client) throw new NotFoundError();
        const iibb = await loadIibbProfile(prisma, id, organizationId);
        return { client, iibb };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, iibb } = guard.data;

    return (
        <ClientProfileForm
            mode="edit"
            initial={{
                id: client.id,
                expectedUpdatedAt: client.updatedAt.toISOString(),
                name: client.name,
                cuit: client.cuit,
                condition: client.condition,
                address: client.address ?? "",
                defaultIibbRate: client.defaultIibbRate.toString(),
                // Históricos sin dato: vacío (pendiente), nunca un valor ficticio.
                phone: client.phone ?? "",
                contactEmail: client.contactEmail ?? "",
                iibbRegistration: client.iibbRegistration,
                jurisdictions: iibb.jurisdictions,
                activities: iibb.activities,
            }}
        />
    );
}
