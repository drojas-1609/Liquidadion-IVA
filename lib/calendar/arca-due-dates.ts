import { hasHolidayCalendar, isBusinessDay, isoDate } from "./holidays";

/**
 * Vencimientos mensuales de ARCA por terminación de CUIT.
 *
 * Días base: Agenda General de Vencimientos, Anexo de la RG (AFIP) 4172
 * (https://biblioteca.afip.gob.ar/pdfp/Anexo_RG_4172.pdf):
 *  - IVA, DDJJ mensual y pago (punto V a): 0-1 día 18; 2-3 día 19; 4-5 día 20;
 *    6-7 día 21; 8-9 día 22 del mes siguiente al período.
 *  - Seguridad social, empleadores, F.931 (punto XVII a): 0-3 día 9; 4-6 día 10;
 *    7-9 día 11 del mes siguiente al período.
 *
 * Corrimiento: cuando un vencimiento cae en día inhábil pasa al día hábil
 * siguiente y los posteriores del mismo grupo se corren en orden (nunca dos
 * terminaciones el mismo día). Con este criterio se reproducen los
 * vencimientos publicados para noviembre de 2026 (IVA: 18, 19, 20, 24 y 25;
 * F.931: 11, 12 y 13). Son fechas calculadas: el calendario que publica ARCA
 * cada mes es el que manda.
 */

export type DueObligation = "IVA" | "SUSS";

interface Schedule {
    label: string;
    detail: string;
    /** Grupos de terminación en orden, con su día base. */
    groups: { digits: readonly number[]; day: number }[];
}

export const SCHEDULES: Record<DueObligation, Schedule> = {
    IVA: {
        label: "IVA",
        detail: "DDJJ mensual, Libro IVA Digital y pago",
        groups: [
            { digits: [0, 1], day: 18 },
            { digits: [2, 3], day: 19 },
            { digits: [4, 5], day: 20 },
            { digits: [6, 7], day: 21 },
            { digits: [8, 9], day: 22 },
        ],
    },
    SUSS: {
        label: "F.931 (SUSS)",
        detail: "DDJJ de aportes y contribuciones y pago",
        groups: [
            { digits: [0, 1, 2, 3], day: 9 },
            { digits: [4, 5, 6], day: 10 },
            { digits: [7, 8, 9], day: 11 },
        ],
    },
};

function addDays(d: Date, n: number): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}

function nextBusinessDay(d: Date): Date {
    let x = d;
    while (!isBusinessDay(x)) x = addDays(x, 1);
    return x;
}

/** Fechas de vencimiento de cada grupo en un mes (month 1-12), con corrimiento sucesivo. */
export function monthDueDates(obligation: DueObligation, year: number, month: number): Date[] {
    const out: Date[] = [];
    let prev: Date | null = null;
    for (const g of SCHEDULES[obligation].groups) {
        let d = new Date(Date.UTC(year, month - 1, g.day));
        if (prev && d.getTime() <= prev.getTime()) d = addDays(prev, 1);
        d = nextBusinessDay(d);
        out.push(d);
        prev = d;
    }
    return out;
}

export interface DueDate {
    obligation: DueObligation;
    label: string;
    detail: string;
    /** YYYY-MM-DD */
    date: string;
    /** Período que vence (mes anterior al del vencimiento), "MM/AAAA". */
    period: string;
    /** false: el año no tiene feriados cargados (la fecha puede correrse). */
    adjusted: boolean;
}

export function lastCuitDigit(cuit: string): number | null {
    const digits = cuit.replace(/\D/g, "");
    return digits.length === 11 ? Number(digits[10]) : null;
}

/** Vencimientos de las obligaciones dadas entre `from` (incluido) y `from + days`. */
export function upcomingDueDates(opts: { cuit: string; obligations: readonly DueObligation[]; from: Date; days: number }): DueDate[] {
    const digit = lastCuitDigit(opts.cuit);
    if (digit === null) return [];
    const start = new Date(Date.UTC(opts.from.getUTCFullYear(), opts.from.getUTCMonth(), opts.from.getUTCDate()));
    const end = addDays(start, opts.days);
    const out: DueDate[] = [];
    for (const ob of opts.obligations) {
        const idx = SCHEDULES[ob].groups.findIndex((g) => g.digits.includes(digit));
        // Mes del vencimiento: el actual y los siguientes hasta cubrir el rango.
        for (let k = 0; k <= Math.ceil(opts.days / 28) + 1; k++) {
            const y = start.getUTCFullYear() + Math.floor((start.getUTCMonth() + k) / 12);
            const m = ((start.getUTCMonth() + k) % 12) + 1;
            const d = monthDueDates(ob, y, m)[idx];
            if (d < start || d > end) continue;
            const py = m === 1 ? y - 1 : y;
            const pm = m === 1 ? 12 : m - 1;
            out.push({
                obligation: ob,
                label: SCHEDULES[ob].label,
                detail: SCHEDULES[ob].detail,
                date: isoDate(d),
                period: `${String(pm).padStart(2, "0")}/${py}`,
                adjusted: hasHolidayCalendar(y),
            });
        }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Días corridos entre hoy y el vencimiento (0 = hoy). */
export function daysUntil(dateIso: string, today: Date): number {
    const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Math.round((Date.parse(`${dateIso}T00:00:00Z`) - t) / 86_400_000);
}
