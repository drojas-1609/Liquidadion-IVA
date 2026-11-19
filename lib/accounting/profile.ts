import { CHART_MODELS, type ChartModel } from "./chart-models";

/**
 * Perfil contable del cliente: plan modelo y certificado MiPyME (para el
 * cómputo del Impuesto sobre los Créditos y Débitos en Ganancias).
 *
 * Cómputo como pago a cuenta del Impuesto a las Ganancias (verificado el
 * 19/11/2026):
 *  - ARCA, «Créditos y Débitos → Cómputo en ganancias»: régimen general 33 %
 *    del impuesto ingresado (Decreto 409/2018, tasas del 6‰ o 12‰); micro y
 *    pequeñas empresas, 100 % (Ley 27.264, art. 6).
 *  - Decreto 409/2018: industrias manufactureras «medianas — tramo 1», 60 %.
 *  - Ministerio de Economía, «Pagos a cuenta» (Decretos 409/2018 y 301/2021):
 *    hechos alcanzados a una alícuota menor, 20 %.
 * Función pura: el porcentaje sólo se aplica si el certificado está vigente en
 * la fecha del movimiento.
 */

export const MIPYME_CATEGORIES = ["MICRO", "PEQUENA", "MEDIANA_T1", "MEDIANA_T2"] as const;
export type MipymeCategory = (typeof MIPYME_CATEGORIES)[number];
export const MIPYME_LABEL: Record<MipymeCategory, string> = {
    MICRO: "Micro", PEQUENA: "Pequeña", MEDIANA_T1: "Mediana tramo 1", MEDIANA_T2: "Mediana tramo 2",
};

export interface AccountingProfile {
    chartModel: ChartModel | null;
    mipymeCategory: MipymeCategory | null;
    /** Sólo relevante para mediana tramo 1 (industria manufacturera). */
    mipymeManufacturing: boolean;
    /** Vigencia del certificado (AAAA-MM-DD); null = sin fecha cargada. */
    mipymeValidUntil: string | null;
}

export type ProfileResult = { ok: true; value: AccountingProfile } | { ok: false; field: string; error: string };

export function validateAccountingProfile(raw: unknown): ProfileResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, field: "accounting", error: "perfil contable inválido" };
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r)) {
        if (!["chartModel", "mipymeCategory", "mipymeManufacturing", "mipymeValidUntil"].includes(k)) return { ok: false, field: `accounting.${k}`, error: "campo no admitido" };
    }
    const chartModel = r.chartModel === undefined || r.chartModel === null || r.chartModel === "" ? null : r.chartModel;
    if (chartModel !== null && !(CHART_MODELS as readonly unknown[]).includes(chartModel)) return { ok: false, field: "accounting.chartModel", error: "plan modelo inválido" };
    const cat = r.mipymeCategory === undefined || r.mipymeCategory === null || r.mipymeCategory === "" ? null : r.mipymeCategory;
    if (cat !== null && !(MIPYME_CATEGORIES as readonly unknown[]).includes(cat)) return { ok: false, field: "accounting.mipymeCategory", error: "categoría MiPyME inválida" };
    if (r.mipymeManufacturing !== undefined && typeof r.mipymeManufacturing !== "boolean") return { ok: false, field: "accounting.mipymeManufacturing", error: "indicación de industria inválida" };
    let until: string | null = null;
    if (r.mipymeValidUntil !== undefined && r.mipymeValidUntil !== null && r.mipymeValidUntil !== "") {
        if (typeof r.mipymeValidUntil !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.mipymeValidUntil) || Number.isNaN(Date.parse(`${r.mipymeValidUntil}T00:00:00Z`))
            || new Date(`${r.mipymeValidUntil}T00:00:00Z`).toISOString().slice(0, 10) !== r.mipymeValidUntil) {
            return { ok: false, field: "accounting.mipymeValidUntil", error: "vigencia del certificado inválida (AAAA-MM-DD)" };
        }
        until = r.mipymeValidUntil;
    }
    if (cat === null && until !== null) return { ok: false, field: "accounting.mipymeValidUntil", error: "indicá la categoría del certificado MiPyME" };
    return {
        ok: true,
        value: { chartModel: chartModel as ChartModel | null, mipymeCategory: cat as MipymeCategory | null, mipymeManufacturing: cat === "MEDIANA_T1" && r.mipymeManufacturing === true, mipymeValidUntil: until },
    };
}

export interface IdcbComputable {
    /** Porcentaje del impuesto ingresado computable como pago a cuenta de Ganancias. */
    percent: 100 | 60 | 33 | 20;
    reason: string;
}

/**
 * Porcentaje computable del Impuesto sobre los Créditos y Débitos.
 * `reducedRate`: el movimiento estuvo alcanzado a una alícuota menor al 6‰.
 */
export function idcbComputablePercent(p: Pick<AccountingProfile, "mipymeCategory" | "mipymeManufacturing" | "mipymeValidUntil">, onDate: string, reducedRate = false): IdcbComputable {
    const valid = p.mipymeCategory !== null && (p.mipymeValidUntil === null || onDate <= p.mipymeValidUntil);
    if (valid && (p.mipymeCategory === "MICRO" || p.mipymeCategory === "PEQUENA")) {
        return { percent: 100, reason: "certificado MiPyME micro/pequeña vigente (Ley 27.264, art. 6)" };
    }
    if (valid && p.mipymeCategory === "MEDIANA_T1" && p.mipymeManufacturing) {
        return { percent: 60, reason: "mediana tramo 1, industria manufacturera (Ley 27.264, art. 6; Decreto 409/2018)" };
    }
    if (reducedRate) return { percent: 20, reason: "hecho imponible a alícuota reducida (Decretos 409/2018 y 301/2021)" };
    return { percent: 33, reason: "régimen general (Decreto 409/2018)" };
}
