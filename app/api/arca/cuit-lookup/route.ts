import { NextResponse } from "next/server";
import { normalizeCuit } from "@/lib/cuit";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { ValidationError } from "@/lib/auth/errors";
import { lookupCuit } from "@/lib/arca-padron/service";
import { ARCA_LOOKUP_LIMITS, arcaLookupLimiter } from "@/lib/arca-padron/rate-limit";
import { ARCA_NOT_CONFIGURED_MESSAGE } from "@/lib/arca-lookup-client";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

const ERROR_RESPONSES = {
    TIMEOUT: { status: 504, code: "ARCA_TIMEOUT", message: "ARCA no respondió a tiempo. Podés reintentar o completar los datos manualmente." },
    UNAVAILABLE: { status: 502, code: "ARCA_UNAVAILABLE", message: "ARCA no está disponible. Podés reintentar o completar los datos manualmente." },
    AUTH: { status: 502, code: "ARCA_AUTH", message: "No se pudo autenticar la consulta ante ARCA. Completá los datos manualmente." },
    INVALID_RESPONSE: { status: 502, code: "ARCA_INVALID_RESPONSE", message: "ARCA devolvió una respuesta que no se pudo interpretar. Completá los datos manualmente." },
} as const;

// POST /api/arca/cuit-lookup — consulta del CUIT en el padrón de ARCA para
// PROPONER datos en el alta o edición de un cliente (OWNER / ADMIN / ACCOUNTANT).
//
// Orden: auth -> organización -> rol -> parseo -> CUIT (422) -> límite de uso
// (429) -> consulta. El CUIT viaja en el cuerpo (no en la URL). La consulta NO
// crea ni modifica clientes, no persiste la respuesta y no registra el CUIT ni
// credenciales. Sin configuración: 200 { status: "NOT_CONFIGURED" } (la UI
// mantiene el alta manual).
export const POST = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const body = await parseJsonBody(request);
    const cuit = normalizeCuit(typeof body === "object" && body !== null ? (body as { cuit?: unknown }).cuit : undefined);
    if (!cuit.ok) throw new ValidationError(cuit.error, "cuit");

    const allowed = arcaLookupLimiter.tryConsume(
        [
            { key: `p:${profileId}`, rule: ARCA_LOOKUP_LIMITS.perProfile },
            { key: `o:${organizationId}`, rule: ARCA_LOOKUP_LIMITS.perOrganization },
        ],
        Date.now(),
    );
    if (!allowed) {
        return NextResponse.json(
            { error: { code: "RATE_LIMITED", message: "Demasiadas consultas a ARCA. Esperá un minuto e intentá de nuevo." } },
            { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } },
        );
    }

    const result = await lookupCuit(cuit.value);
    switch (result.status) {
        case "FOUND":
            return NextResponse.json(
                { status: "FOUND", cuit: result.cuit, source: result.source, consultedAt: result.consultedAt, person: result.person },
                { headers: NO_STORE },
            );
        case "NOT_FOUND":
            return NextResponse.json({ status: "NOT_FOUND", cuit: result.cuit }, { headers: NO_STORE });
        case "NOT_CONFIGURED":
            return NextResponse.json({ status: "NOT_CONFIGURED", message: ARCA_NOT_CONFIGURED_MESSAGE }, { headers: NO_STORE });
        case "INVALID_CUIT":
            throw new ValidationError(result.error, "cuit");
        case "ERROR": {
            const e = ERROR_RESPONSES[result.code];
            return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status, headers: NO_STORE });
        }
    }
});
