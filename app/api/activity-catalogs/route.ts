import { NextResponse } from "next/server";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, withApiAuthz } from "@/lib/auth/authz";
import { ROLES_READ } from "@/lib/auth/roles";
import { activityCatalogs } from "@/lib/activity-catalog/registry";
import { isValidOn } from "@/lib/activity-catalog/validate";
import { CATALOG_REVIEW_LEVELS, isApproved } from "@/lib/activity-catalog/review";
import { todayInArgentina } from "@/lib/activity-catalog/date";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

// GET /api/activity-catalogs — versiones de catálogos oficiales PUBLICADAS
// (revisadas) con su fuente, norma y vigencia. Las pendientes de revisión no
// se listan. Datos públicos; sólo lectura.
export const GET = withApiAuthz(async () => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_READ);

    const today = todayInArgentina();
    const catalogs = activityCatalogs()
        .filter((c) => isApproved(c.manifest.review, CATALOG_REVIEW_LEVELS))
        .map(({ manifest: m }) => ({
            id: m.id,
            nomenclator: m.nomenclator,
            jurisdiction: m.jurisdiction,
            name: m.name,
            organism: m.organism,
            norm: m.norm,
            version: m.version,
            sourceUrl: m.sourceUrl,
            publishedAt: m.publishedAt,
            consultedAt: m.consultedAt,
            validFrom: m.validFrom,
            validTo: m.validTo,
            validToday: isValidOn(m, today),
            entryCount: m.entryCount,
        }));
    return NextResponse.json({ date: today, catalogs }, { headers: NO_STORE });
});
