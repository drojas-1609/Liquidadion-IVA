import { describe, expect, it } from "vitest";
import { isScheduledDay, parseExtraDays, scheduleDate } from "@/lib/arca-sync/calendar";

describe("calendario de importación ARCA", () => {
    it("acepta dos fechas adicionales distintas del 25", () => {
        expect(parseExtraDays([31, 8])).toEqual([8, 31]);
        for (const invalid of [[25], [8, 8], [1, 2, 3], [32], ["8"], [1.5]]) {
            expect(parseExtraDays(invalid)).toBeNull();
        }
    });

    it("usa el día 25 de Buenos Aires", () => {
        expect(isScheduledDay(scheduleDate(new Date("2026-11-25T02:59:00Z")), [])).toBe(false);
        expect(isScheduledDay(scheduleDate(new Date("2026-11-25T03:00:00Z")), [])).toBe(true);
    });

    it("mueve los días que no existen al último día del mes", () => {
        const february = scheduleDate(new Date("2028-02-29T12:00:00Z"));
        expect(february.key).toBe("2028-02-29");
        expect(isScheduledDay(february, [30, 31])).toBe(true);
    });
});
