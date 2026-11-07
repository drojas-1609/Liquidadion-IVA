import { normalizeCuit } from "./cuit";
import type { CuitLookupOutcome } from "./arca-lookup-client";

/**
 * «Consultar CUIT en ARCA» en el alta y la edición de comprobantes (ventas y
 * compras). Reutiliza el MISMO servicio que la ficha de clientes
 * (POST /api/arca/cuit-lookup: permisos, módulo ARCA_PADRON, cupos y
 * auditoría); acá sólo se arma la PROPUESTA para la contraparte. Lógica pura,
 * apta para el navegador.
 *
 *  - Sólo con documento 80 (CUIT) y un CUIT válido; con otro documento la
 *    consulta no se ofrece.
 *  - Se propone únicamente la denominación. Si el formulario ya tiene otra, no
 *    se reemplaza sin confirmación expresa (nunca en silencio).
 *  - La condición frente al IVA NO se deduce: el padrón (ws_sr_constancia_
 *    inscripcion, manual v3.4) informa impuestos y régimen, pero no define su
 *    correspondencia con la tabla «Tipos de responsables». Se muestran como
 *    información y el usuario elige la condición.
 *  - Nunca modifica la ficha del cliente del estudio ni guarda la respuesta.
 */

export const DOC_TYPE_CUIT_LOOKUP = 80;

/** CUIT consultable (11 dígitos con dígito verificador) o null. */
export function lookupCuitFrom(docType: number | null, docNumber: string): string | null {
    if (docType !== DOC_TYPE_CUIT_LOOKUP) return null;
    const n = normalizeCuit(docNumber);
    return n.ok ? n.value : null;
}

export interface CounterpartyProposal {
    cuit: string;
    consultedAt: string;
    source: string;
    /** null si ARCA no informa denominación. */
    proposedName: string | null;
    /** El formulario ya tiene OTRA denominación: aplicar exige confirmación. */
    overwrites: boolean;
    /** Ya coincide con lo cargado: no hay nada que aplicar. */
    sameAsCurrent: boolean;
    /** Impuestos, estado y categoría de monotributo informados por ARCA (sólo lectura). */
    registrationInfo: string[];
    notices: string[];
    /** Siempre explica que la condición la elige el usuario. */
    conditionNote: string;
}

export const CONDITION_NOT_DEDUCED =
    "ARCA informa los impuestos y el régimen, pero no la condición frente al IVA de la tabla «Tipos de responsables»: elegila vos con esta información.";

export function buildCounterpartyProposal(outcome: Extract<CuitLookupOutcome, { status: "FOUND" }>, currentName: string): CounterpartyProposal {
    const proposed = outcome.person.name?.trim() || null;
    const current = currentName.trim();
    const same = proposed !== null && current.localeCompare(proposed, "es", { sensitivity: "accent" }) === 0;
    return {
        cuit: outcome.cuit,
        consultedAt: outcome.consultedAt,
        source: outcome.source,
        proposedName: proposed,
        overwrites: proposed !== null && current !== "" && !same,
        sameAsCurrent: same,
        registrationInfo: [
            ...outcome.person.taxes.map((t) => (t.status ? `${t.description} (${t.status})` : t.description)),
            ...(outcome.person.monotributoCategory ? [`Monotributo: categoría ${outcome.person.monotributoCategory}`] : []),
            ...(outcome.person.keyStatus ? [`Estado de la clave: ${outcome.person.keyStatus}`] : []),
        ],
        notices: outcome.person.notices,
        conditionNote: CONDITION_NOT_DEDUCED,
    };
}

/** Nombre a aplicar: sólo con confirmación si reemplaza otro (si no, null = no se toca). */
export function applyCounterpartyName(p: CounterpartyProposal, confirmOverwrite: boolean): string | null {
    if (p.proposedName === null || p.sameAsCurrent) return null;
    if (p.overwrites && !confirmOverwrite) return null;
    return p.proposedName;
}
