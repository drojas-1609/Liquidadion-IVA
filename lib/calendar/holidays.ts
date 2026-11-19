/**
 * Días inhábiles para los vencimientos de ARCA, por año cargado.
 *
 * Fuente: calendario oficial de la Jefatura de Gabinete
 * (https://www.argentina.gob.ar/jefatura/feriados-nacionales-2026, consultado
 * el 19/11/2026): feriados inamovibles y trasladables (en la fecha en que se
 * observan), días no laborables con fines turísticos (Res. JGM 164/2025) y el
 * feriado del 9/11/2026 (Decreto 1103/2026). Se incluye el 10/11/2026 (feriado
 * en CABA por la visita papal): ARCA corrió los vencimientos de noviembre de
 * 2026 tratándolo como inhábil. No se incluyen los días no laborables
 * religiosos (opcionales) ni feriados provinciales.
 *
 * Un año que no está acá no tiene feriados cargados: las fechas de ese año se
 * marcan como no ajustadas.
 */
export const INHABILES: Readonly<Record<number, readonly string[]>> = {
    2026: [
        "2026-01-01",
        "2026-02-16",
        "2026-02-17",
        "2026-03-23",
        "2026-03-24",
        "2026-04-02",
        "2026-04-03",
        "2026-05-01",
        "2026-05-25",
        "2026-06-15",
        "2026-06-20",
        "2026-07-09",
        "2026-07-10",
        "2026-08-17",
        "2026-10-12",
        "2026-11-09",
        "2026-11-10",
        "2026-11-23",
        "2026-12-07",
        "2026-12-08",
        "2026-12-25",
    ],
};

export function hasHolidayCalendar(year: number): boolean {
    return Object.prototype.hasOwnProperty.call(INHABILES, year);
}

/** Fecha ISO (YYYY-MM-DD) de un Date UTC. */
export function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

export function isBusinessDay(d: Date): boolean {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    return !(INHABILES[d.getUTCFullYear()] ?? []).includes(isoDate(d));
}
