import { NextResponse } from "next/server";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, withApiAuthz } from "@/lib/auth/authz";
import { ROLES_READ } from "@/lib/auth/roles";
import { ValidationError } from "@/lib/auth/errors";
import { activityCatalogs } from "@/lib/activity-catalog/registry";
import { searchCatalogs } from "@/lib/activity-catalog/search";
import { CATALOG_NOMENCLATORS, type CatalogNomenclator } from "@/lib/activity-catalog/types";
import { isJurisdictionCode } from "@/lib/iibb/jurisdictions";
import { isIsoDateString, todayInArgentina } from "@/lib/activity-catalog/date";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;
const MAX_QUERY = 80;

// GET /api/activity-catalogs/search?q=...&nomenclator=NAES[&jurisdiction=901][&catalogId=...][&date=AAAA-MM-DD][&historical=1]
// Busca en versiones REVISADAS (y vigentes en la fecha, salvo historical=1)
// por código, descripción o referencia. Los parámetros son términos del
// catálogo público, nunca datos de contribuyentes.
export const GET = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_READ);

    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length === 0 || q.length > MAX_QUERY) throw new ValidationError(`ingresá entre 1 y ${MAX_QUERY} caracteres`, "q");
    const nomenclator = url.searchParams.get("nomenclator");
    if (nomenclator !== null && !(CATALOG_NOMENCLATORS as readonly string[]).includes(nomenclator)) throw new ValidationError("nomenclador inválido", "nomenclator");
    const jurisdiction = url.searchParams.get("jurisdiction");
    if (jurisdiction !== null && !isJurisdictionCode(jurisdiction)) throw new ValidationError("jurisdicción inválida", "jurisdiction");
    if (nomenclator === "PROVINCIAL" && jurisdiction === null) throw new ValidationError("indicá la jurisdicción del nomenclador provincial", "jurisdiction");
    const date = url.searchParams.get("date") ?? todayInArgentina();
    if (!isIsoDateString(date)) throw new ValidationError("fecha inválida (AAAA-MM-DD)", "date");

    const results = searchCatalogs(activityCatalogs(), q, {
        nomenclator: (nomenclator ?? undefined) as CatalogNomenclator | undefined,
        jurisdiction: jurisdiction ?? undefined,
        catalogId: url.searchParams.get("catalogId") ?? undefined,
        date,
        includeNotValid: url.searchParams.get("historical") === "1",
        limit: 20,
    });
    return NextResponse.json({ date, results }, { headers: NO_STORE });
});
