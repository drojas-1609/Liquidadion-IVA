/**
 * Modalidad de prorrateo del crédito fiscal del período (art. 13 Ley de IVA)
 * y coeficiente global cargado por el estudio. Sin dependencias de servidor:
 * lo usan la API y el formulario.
 */
export const PRORATION_MODES = ["NONE", "DIRECT", "GLOBAL", "DIRECT_AND_GLOBAL"] as const;
export type ProrationMode = (typeof PRORATION_MODES)[number];
export const COEFFICIENT_STATUSES = ["PROVISIONAL", "DEFINITIVE"] as const;
export type CoefficientStatus = (typeof COEFFICIENT_STATUSES)[number];

/** Rótulos como los muestra IVA Simple. */
export const PRORATION_MODE_LABELS: Record<ProrationMode, string> = {
    NONE: "Sin prorrateo",
    DIRECT: "Con prorrateo por asignación directa",
    GLOBAL: "Con prorrateo global",
    DIRECT_AND_GLOBAL: "Con prorrateo por asignación directa y global",
};
export const COEFFICIENT_STATUS_LABELS: Record<CoefficientStatus, string> = { PROVISIONAL: "Provisional", DEFINITIVE: "Definitivo" };

export const PRORATION_HAS_GLOBAL_LINES_MESSAGE =
    "El período tiene compras con IVA sujeto a prorrateo global: no se puede pasar a una modalidad sin prorrateo global.";

export const usesGlobalCoefficient = (mode: string) => mode === "GLOBAL" || mode === "DIRECT_AND_GLOBAL";

export interface CreditProrationData {
    creditProrationMode: ProrationMode;
    /** Decimal exacto como texto ("0.5132"), entre 0 y 1, hasta 10 decimales; null = sin cargar. */
    globalCoefficient: string | null;
    globalCoefficientStatus: CoefficientStatus | null;
}

type Result = { ok: true; data: CreditProrationData } | { ok: false; field: string; error: string };
const fail = (field: string, error: string): Result => ({ ok: false, field, error });

export function buildCreditProrationInput(body: unknown): Result {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("body", "cuerpo inválido");
    const b = body as Record<string, unknown>;
    const mode = b.creditProrationMode;
    if (typeof mode !== "string" || !(PRORATION_MODES as readonly string[]).includes(mode)) return fail("creditProrationMode", "modalidad de prorrateo inválida");
    let coefficient: string | null = null;
    const raw = b.globalCoefficient;
    if (raw !== undefined && raw !== null && raw !== "") {
        if (typeof raw !== "string") return fail("globalCoefficient", "el coeficiente debe ser texto (p. ej. 0,5132)");
        const s = raw.trim().replace(",", ".");
        if (!/^(0(\.\d{1,10})?|1(\.0{1,10})?)$/.test(s)) return fail("globalCoefficient", "el coeficiente va entre 0 y 1, con hasta 10 decimales (p. ej. 0,5132)");
        coefficient = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    }
    if (coefficient !== null && !usesGlobalCoefficient(mode)) return fail("globalCoefficient", "el coeficiente sólo corresponde con prorrateo global");
    let status: CoefficientStatus | null = null;
    if (coefficient !== null) {
        if (typeof b.globalCoefficientStatus !== "string" || !(COEFFICIENT_STATUSES as readonly string[]).includes(b.globalCoefficientStatus)) {
            return fail("globalCoefficientStatus", "indicá si el coeficiente es provisional o definitivo");
        }
        status = b.globalCoefficientStatus as CoefficientStatus;
    }
    return { ok: true, data: { creditProrationMode: mode as ProrationMode, globalCoefficient: coefficient, globalCoefficientStatus: status } };
}
