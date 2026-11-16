/**
 * Datos iniciales que IVA Simple (Portal IVA) pide al abrir el borrador de un
 * período, antes de mostrar los libros. Son respuestas de la declaración: el
 * conector nunca las supone. Se guardan como predeterminados del cliente y,
 * para cada período, la persona confirma o cambia la elección en la primera
 * importación del mes (por ejemplo, TurIVA puede variar de un mes a otro).
 *
 * La registración es siempre «Con movimientos»: el conector sólo descarga.
 * Sin datos válidos el conector se detiene con ARCA_INITIAL_DATA_REQUIRED.
 * Sin dependencias de servidor: lo usan la API, el panel y el conector.
 */
export const CREDIT_COMPUTATIONS = ["DIRECT", "GLOBAL", "DIRECT_AND_GLOBAL"] as const;
export type CreditComputation = (typeof CREDIT_COMPUTATIONS)[number];

export interface ArcaInitialData {
    nonTaxedOrExempt: boolean;
    /** Obligatoria con operaciones no gravadas o exentas; null en otro caso. */
    creditComputation: CreditComputation | null;
    definitiveImports: boolean;
    serviceImports: boolean;
    turiva: boolean;
    usedGoods: boolean;
}

export const OPERATION_FIELDS = ["nonTaxedOrExempt", "definitiveImports", "serviceImports", "turiva", "usedGoods"] as const;

/** Rótulos tal como los muestra IVA Simple (observados el 15/11/2026). */
export const OPERATION_LABELS: Record<(typeof OPERATION_FIELDS)[number], string> = {
    nonTaxedOrExempt: "Operaciones No Gravadas o Exentas",
    definitiveImports: "Importación definitiva de bienes",
    serviceImports: "Importación de servicios",
    turiva: "Incluido en el régimen TurIVA",
    usedGoods: "Compras de bienes usados o material reciclable",
};
export const NO_OPERATIONS_LABEL = "No realizo ninguna actividad anterior";
export const CREDIT_COMPUTATION_LABELS: Record<CreditComputation, string> = {
    DIRECT: "Con prorrateo por asignación directa",
    GLOBAL: "Con prorrateo global",
    DIRECT_AND_GLOBAL: "Con prorrateo por asignación directa y global",
};

export function parseInitialData(raw: unknown): { ok: true; value: ArcaInitialData } | { ok: false; error: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Los datos iniciales deben ser un objeto." };
    const input = raw as Record<string, unknown>;
    const allowed = new Set<string>([...OPERATION_FIELDS, "creditComputation"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) return { ok: false, error: `Dato inicial desconocido: ${key}.` };
    const value = {} as ArcaInitialData;
    for (const field of OPERATION_FIELDS) {
        if (typeof input[field] !== "boolean") return { ok: false, error: `Falta indicar «${OPERATION_LABELS[field]}».` };
        value[field] = input[field] as boolean;
    }
    const credit = input.creditComputation ?? null;
    if (value.nonTaxedOrExempt) {
        if (!CREDIT_COMPUTATIONS.includes(credit as CreditComputation)) return { ok: false, error: "Con operaciones no gravadas o exentas hay que elegir la forma de cómputo del crédito fiscal." };
        value.creditComputation = credit as CreditComputation;
    } else {
        if (credit !== null) return { ok: false, error: "La forma de cómputo del crédito fiscal sólo corresponde con operaciones no gravadas o exentas." };
        value.creditComputation = null;
    }
    return { ok: true, value };
}

/** Datos guardados en la base; los inválidos cuentan como ausentes. */
export function storedInitialData(raw: unknown): ArcaInitialData | null {
    const parsed = parseInitialData(raw);
    return parsed.ok ? parsed.value : null;
}

/** Monotributo consulta Mis Comprobantes; el resto, el Portal IVA (regla del estudio, 15/11/2026). */
export const usesPortalIva = (condition: string | null | undefined) => condition !== "Monotributo";
