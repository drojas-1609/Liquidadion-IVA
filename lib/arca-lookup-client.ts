/**
 * Consulta de CUIT en ARCA desde el formulario de clientes (navegador).
 *
 * Lógica pura y testeable:
 *  - `requestCuitLookup`: llama al endpoint y traduce la respuesta;
 *  - `createLookupSequencer`: descarta respuestas viejas o de otro CUIT;
 *  - `buildArcaProposal`: arma una propuesta REVISABLE campo por campo, sin
 *    pisar valores editados salvo confirmación explícita;
 *  - `applyArcaProposal`: aplica sólo los campos elegidos.
 *
 * ARCA no informa teléfono ni email: nunca se proponen. Tampoco se infiere la
 * inscripción en Ingresos Brutos, jurisdicciones ni equivalencias de
 * actividades: las actividades se proponen con nomenclador "ARCA".
 */
import { normalizeCuit } from "./cuit";
import { readApiError } from "./new-client-submit";

export const ARCA_NOT_CONFIGURED_MESSAGE = "Consulta ARCA no configurada";
export const ARCA_GENERIC_ERROR = "No se pudo consultar ARCA. Podés completar los datos manualmente.";

export interface ArcaPersonDTO {
    idPersona: string;
    name: string | null;
    personType: string | null;
    keyStatus: string | null;
    fiscalAddress: {
        street: string | null;
        locality: string | null;
        postalCode: string | null;
        provinceArcaId: string | null;
        provinceName: string | null;
    } | null;
    taxes: Array<{ id: string; description: string; status: string | null }>;
    monotributoCategory: string | null;
    activities: Array<{ code: string; description: string; nomenclator: string | null; order: number | null; period: string | null }>;
    notices: string[];
    sourceDateTime: string | null;
}

export type CuitLookupOutcome =
    | { status: "FOUND"; cuit: string; source: string; consultedAt: string; person: ArcaPersonDTO }
    | { status: "NOT_FOUND"; cuit: string }
    | { status: "NOT_CONFIGURED"; message: string }
    | { status: "ERROR"; message: string };

export async function requestCuitLookup(cuit: string, fetchImpl: typeof fetch = fetch): Promise<CuitLookupOutcome> {
    let res: Response;
    try {
        res = await fetchImpl("/api/arca/cuit-lookup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cuit }),
        });
    } catch {
        return { status: "ERROR", message: ARCA_GENERIC_ERROR };
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
        const apiError = readApiError(body);
        return { status: "ERROR", message: apiError?.message ?? ARCA_GENERIC_ERROR };
    }
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.status === "NOT_CONFIGURED") return { status: "NOT_CONFIGURED", message: ARCA_NOT_CONFIGURED_MESSAGE };
    if (b.status === "NOT_FOUND" && typeof b.cuit === "string") return { status: "NOT_FOUND", cuit: b.cuit };
    if (
        b.status === "FOUND" &&
        typeof b.cuit === "string" &&
        typeof b.source === "string" &&
        typeof b.consultedAt === "string" &&
        typeof b.person === "object" &&
        b.person !== null
    ) {
        return { status: "FOUND", cuit: b.cuit, source: b.source, consultedAt: b.consultedAt, person: b.person as ArcaPersonDTO };
    }
    return { status: "ERROR", message: ARCA_GENERIC_ERROR };
}

/**
 * Guarda de secuencia: cada consulta recibe un ticket; una respuesta sólo se
 * acepta si es la de la ÚLTIMA consulta y el CUIT del formulario (normalizado)
 * sigue siendo el consultado.
 */
export function createLookupSequencer() {
    let current = 0;
    return {
        start(): number {
            current += 1;
            return current;
        },
        /** Invalida cualquier consulta en curso (p. ej. el usuario cambió el CUIT). */
        cancel(): void {
            current += 1;
        },
        accepts(ticket: number, queriedCuit: string, formCuit: string): boolean {
            if (ticket !== current) return false;
            const a = normalizeCuit(queriedCuit);
            const b = normalizeCuit(formCuit);
            return a.ok && b.ok && a.value === b.value;
        },
    };
}

/** Campos del formulario que ARCA puede proponer. */
export interface ProposableFields {
    name: string;
    address: string;
}

export interface FieldProposal {
    field: keyof ProposableFields;
    label: string;
    current: string;
    proposed: string;
    /** true si el campo ya tiene otro valor: aplicar requiere confirmación explícita. */
    overwrites: boolean;
    /** Selección inicial: sólo los campos vacíos se preseleccionan. */
    selected: boolean;
}

export interface ActivityProposal {
    code: string;
    description: string;
    nomenclatorReference: string | null;
    /** Ya existe una actividad ARCA con ese código en el formulario. */
    alreadyPresent: boolean;
    selected: boolean;
}

export interface ArcaProposal {
    cuit: string;
    source: string;
    consultedAt: string;
    fields: FieldProposal[];
    activities: ActivityProposal[];
    /** Información de inscripción informada por ARCA (sólo lectura, no se aplica a la ficha IIBB). */
    registrationInfo: string[];
    notices: string[];
}

export function formatArcaAddress(a: ArcaPersonDTO["fiscalAddress"]): string {
    if (!a) return "";
    const locality = [a.locality, a.postalCode ? `(CP ${a.postalCode})` : null].filter(Boolean).join(" ");
    return [a.street, locality, a.provinceName].filter((x) => x && x.trim() !== "").join(", ");
}

export function buildArcaProposal(
    outcome: Extract<CuitLookupOutcome, { status: "FOUND" }>,
    form: ProposableFields,
    existingArcaActivityCodes: readonly string[],
): ArcaProposal {
    const fields: FieldProposal[] = [];
    const add = (field: keyof ProposableFields, label: string, proposed: string) => {
        const p = proposed.trim();
        if (p === "") return;
        const current = form[field].trim();
        if (current === p) return;
        fields.push({ field, label, current, proposed: p, overwrites: current !== "", selected: current === "" });
    };
    add("name", "Nombre / Razón Social", outcome.person.name ?? "");
    add("address", "Dirección (domicilio fiscal según ARCA)", formatArcaAddress(outcome.person.fiscalAddress));

    const existing = new Set(existingArcaActivityCodes.map((c) => c.toUpperCase()));
    const activities = outcome.person.activities.map((a) => {
        const alreadyPresent = existing.has(a.code.toUpperCase());
        return {
            code: a.code,
            description: a.description,
            nomenclatorReference: a.nomenclator,
            alreadyPresent,
            selected: false,
        };
    });

    const registrationInfo = [
        ...outcome.person.taxes.map((t) => (t.status ? `${t.description} (${t.status})` : t.description)),
        ...(outcome.person.monotributoCategory ? [`Monotributo: ${outcome.person.monotributoCategory}`] : []),
    ];

    return {
        cuit: outcome.cuit,
        source: outcome.source,
        consultedAt: outcome.consultedAt,
        fields,
        activities,
        registrationInfo,
        notices: outcome.person.notices,
    };
}

export interface ProposalSelection {
    fields: ReadonlyArray<keyof ProposableFields>;
    /** Confirmación explícita para reemplazar valores existentes. */
    confirmOverwrite: boolean;
    activityCodes: readonly string[];
}

/**
 * Valores a aplicar. Un campo con valor previo distinto sólo se reemplaza si
 * el usuario lo seleccionó Y confirmó el reemplazo. Las actividades ya
 * presentes nunca se duplican.
 */
export function applyArcaProposal(
    proposal: ArcaProposal,
    selection: ProposalSelection,
): { fields: Partial<ProposableFields>; activities: Array<{ code: string; description: string; nomenclatorReference: string | null }> } {
    const fields: Partial<ProposableFields> = {};
    for (const f of proposal.fields) {
        if (!selection.fields.includes(f.field)) continue;
        if (f.overwrites && !selection.confirmOverwrite) continue;
        fields[f.field] = f.proposed;
    }
    const activities = proposal.activities
        .filter((a) => !a.alreadyPresent && selection.activityCodes.includes(a.code))
        .map((a) => ({ code: a.code, description: a.description, nomenclatorReference: a.nomenclatorReference }));
    return { fields, activities };
}
