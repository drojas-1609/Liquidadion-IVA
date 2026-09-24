import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_CLIENT_MANAGE } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { EditClientForm } from "./edit-client-form";

export const dynamic = "force-dynamic";

// Edición de cliente: sólo OWNER / ADMIN. Otra organización o inexistente -> 404.
export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await requireClientAccess(profileId, id, ROLES_CLIENT_MANAGE);
        const client = await prisma.client.findFirst({ where: { id, organizationId } });
        if (!client) throw new NotFoundError();
        return client;
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const client = guard.data;

    return (
        <EditClientForm
            client={{
                id: client.id,
                name: client.name,
                cuit: client.cuit,
                condition: client.condition,
                address: client.address ?? "",
                defaultIibbRate: client.defaultIibbRate.toString(),
            }}
        />
    );
}
