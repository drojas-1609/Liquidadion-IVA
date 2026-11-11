export const ARCA_SYNC_SOURCES = ["SALES", "PURCHASES", "RETENTIONS", "PERCEPTIONS"] as const;
export const ARCA_SYNC_TERMINAL = ["DONE", "EMPTY", "REVIEW"] as const;

export function parseExtraDays(input: unknown): number[] | null {
    if (!Array.isArray(input) || input.length > 2) return null;
    const days = input as unknown[];
    if (days.some((day) => typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31 || day === 25)) return null;
    return new Set(days).size === days.length ? (days as number[]).sort((a, b) => a - b) : null;
}

export function scheduleDate(now: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)!.value;
    const year = Number(part("year"));
    const month = Number(part("month"));
    const day = Number(part("day"));
    return { year, month, day, lastDay: new Date(Date.UTC(year, month, 0)).getUTCDate(), key: `${part("year")}-${part("month")}-${part("day")}` };
}

export function isScheduledDay(date: ReturnType<typeof scheduleDate>, extraDays: readonly number[]) {
    return [25, ...extraDays].some((day) => Math.min(day, date.lastDay) === date.day);
}
