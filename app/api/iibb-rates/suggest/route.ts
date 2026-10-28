import { NextResponse } from "next/server";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { ValidationError } from "@/lib/auth/errors";
import { usableRateRuleSets } from "@/lib/iibb-rates/registry";
import { suggestRate } from "@/lib/iibb-rates/suggest";
import { isJurisdictionCode } from "@/lib/iibb/jurisdictions";
import { isIibbRegistration } from "@/lib/iibb/registration";
import { isIsoDateString, todayInArgentina } from "@/lib/activity-catalog/date";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;
const MONEY = /^\d{1,15}(\.\d{1,2})?$/;

// POST /api/iibb-rates/suggest — alternativas VERIFICADAS de alícuota para una
// actividad y jurisdicción. No escribe nada ni completa la ficha: el estudio
// confirma (o no) en el formulario. Los datos del cliente viajan en el cuerpo,
// nunca en la URL, y no se registran.
export const POST = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const body = await parseJsonBody(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError("cuerpo inválido", "body");
    const b = body as Record<string, unknown>;
    if (!isJurisdictionCode(b.jurisdiction)) throw new ValidationError("jurisdicción inválida", "jurisdiction");
    if (typeof b.nomenclator !== "string" || !["ARCA", "NAES", "PROVINCIAL", "OTRO"].includes(b.nomenclator)) throw new ValidationError("nomenclador inválido", "nomenclator");
    if (typeof b.code !== "string" || !/^[0-9A-Za-z.\-/]{1,20}$/.test(b.code)) throw new ValidationError("código inválido", "code");
    const catalogId = b.catalogId === undefined || b.catalogId === null ? null : b.catalogId;
    if (catalogId !== null && (typeof catalogId !== "string" || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(catalogId))) throw new ValidationError("catálogo inválido", "catalogId");
    const date = b.date === undefined ? todayInArgentina() : b.date;
    if (!isIsoDateString(date)) throw new ValidationError("fecha inválida (AAAA-MM-DD)", "date");
    const registration = b.registration === undefined || b.registration === null || b.registration === "" ? null : b.registration;
    if (registration !== null && !isIibbRegistration(registration)) throw new ValidationError("inscripción inválida", "registration");
    const facts = typeof b.facts === "object" && b.facts !== null ? (b.facts as Record<string, unknown>) : {};
    const income = facts.priorYearGrossIncome;
    if (income !== undefined && income !== null && (typeof income !== "string" || !MONEY.test(income))) {
        throw new ValidationError("ingresos del ejercicio anterior inválidos", "facts.priorYearGrossIncome");
    }
    const declared: Record<string, boolean> = {};
    if (typeof facts.declared === "object" && facts.declared !== null) {
        for (const [k, v] of Object.entries(facts.declared as Record<string, unknown>)) {
            if (/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/.test(k) && typeof v === "boolean") declared[k] = v;
        }
    }

    const suggestion = suggestRate(usableRateRuleSets(), {
        jurisdiction: b.jurisdiction,
        nomenclator: b.nomenclator,
        catalogId,
        code: b.code,
        date,
        registration,
        facts: { priorYearGrossIncome: (income as string | null | undefined) ?? null, declared },
    });
    // ARCA/CLAE nunca determina la tasa provincial: sin reglas para ese nomenclador.
    return NextResponse.json({ date, suggestion }, { headers: NO_STORE });
});
