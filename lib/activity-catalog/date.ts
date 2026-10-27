/** Fecha de hoy (AAAA-MM-DD) en Argentina, para elegir versiones vigentes. */
export function todayInArgentina(now: Date = new Date()): string {
    // en-CA formatea como AAAA-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** AAAA-MM-DD calendario válido. */
export function isIsoDateString(v: unknown): v is string {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
