/**
 * IIBB F2: alícuotas por año fiscal (lógica pura).
 *
 * La ficha del cliente representa el AÑO EN CURSO: al guardarla se actualizan
 * las filas de ese año. Los años anteriores quedan fijos para que un período
 * viejo se siga liquidando con la alícuota de su año.
 */
import { Prisma } from "@prisma/client";
import { todayInArgentina } from "../activity-catalog/date";

export type RateTreatmentValue = "RATE" | "EXEMPT";

export interface RateYearValue {
    jurisdictionCode: string;
    activityCode: string;
    rate: Prisma.Decimal | null;
    treatment: RateTreatmentValue;
    rateOrigin: "STUDIO_MANUAL" | "CONFIRMED_SUGGESTION" | null;
    ruleRef: string | null;
    minimumAmount?: Prisma.Decimal | null;
}

/** Año fiscal en curso según la fecha de Argentina. */
export function currentFiscalYear(today: string = todayInArgentina()): number {
    return Number(today.slice(0, 4));
}

/** Sólo cuentan las alícuotas informadas (tasa cargada o exención). */
export function isInformed(v: Pick<RateYearValue, "rate" | "treatment">): boolean {
    return v.treatment === "EXEMPT" || v.rate !== null;
}

const key = (v: Pick<RateYearValue, "jurisdictionCode" | "activityCode">) => `${v.jurisdictionCode}|${v.activityCode}`;
const same = (a: RateYearValue, b: RateYearValue) =>
    a.treatment === b.treatment &&
    (a.rate === null ? b.rate === null : b.rate !== null && a.rate.equals(b.rate)) &&
    a.rateOrigin === b.rateOrigin &&
    a.ruleRef === b.ruleRef &&
    ((a.minimumAmount ?? null) === null ? (b.minimumAmount ?? null) === null : b.minimumAmount != null && a.minimumAmount!.equals(b.minimumAmount));

/**
 * Diferencia entre las filas de un año y las alícuotas de la ficha: qué borrar
 * (ya no informadas o cambiadas) y qué crear (nuevas o cambiadas). Las que no
 * cambian se conservan con su fecha y autor de confirmación.
 */
export function diffRateYear(existing: readonly (RateYearValue & { id: string })[], desired: readonly RateYearValue[]) {
    const want = new Map(desired.filter(isInformed).map((d) => [key(d), d]));
    const remove: string[] = [];
    const keep = new Set<string>();
    for (const e of existing) {
        const d = want.get(key(e));
        if (d && same(e, d)) keep.add(key(e));
        else remove.push(e.id);
    }
    const create = [...want.values()].filter((d) => !keep.has(key(d)));
    return { remove, create };
}

/** Elige la alícuota del año si está; si no, la de la ficha con la marca `fromProfile`. */
export function pickYearRate(
    year: ReadonlyMap<string, Pick<RateYearValue, "rate" | "treatment" | "minimumAmount">>,
    profile: Pick<RateYearValue, "rate" | "treatment" | "minimumAmount"> | undefined,
    jurisdictionCode: string,
    activityCode: string,
): { rate: Prisma.Decimal | null; exempt: boolean; fromProfile: boolean; minimum: Prisma.Decimal | null } {
    const y = year.get(`${jurisdictionCode}|${activityCode}`);
    if (y) return { rate: y.treatment === "RATE" ? y.rate : null, exempt: y.treatment === "EXEMPT", fromProfile: false, minimum: y.minimumAmount ?? null };
    if (profile && isInformed(profile))
        return { rate: profile.treatment === "RATE" ? profile.rate : null, exempt: profile.treatment === "EXEMPT", fromProfile: true, minimum: profile.minimumAmount ?? null };
    return { rate: null, exempt: false, fromProfile: false, minimum: null };
}

export const rateYearKey = key;
