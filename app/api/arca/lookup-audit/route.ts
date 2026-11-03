import { NextResponse } from "next/server";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, withApiAuthz } from "@/lib/auth/authz";
import { ROLES_AUDIT_READ } from "@/lib/auth/roles";
import { listLookupAudit } from "@/lib/arca-padron/lookup-audit";

// GET /api/arca/lookup-audit — últimas consultas a ARCA de la organización
// activa (OWNER / ADMIN). Sólo perfil, fecha y resultado; sin CUIT ni respuestas.
export const GET = withApiAuthz(async () => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_AUDIT_READ);
    return NextResponse.json({ entries: await listLookupAudit(organizationId) }, { headers: { "Cache-Control": "no-store, max-age=0" } });
});
