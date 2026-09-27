import { describe, it, expect } from "vitest";
import { periodFirstDayIso, periodLastDayIso } from "@/lib/period";
import * as rules from "@/lib/invoice-rules";
import {
    checkVoucherDate,
    duplicateVoucherMessage,
    duplicateVoucherWhere,
    type VoucherIdentity,
} from "@/lib/invoice-rules";

const d = (iso: string) => new Date(iso);
const MAY_2026 = { year: 2026, month: 5 };

describe("lib/period — límites del período (sin zona horaria)", () => {
    it("primer y último día de meses de 31, 30 y 28 días", () => {
        expect(periodFirstDayIso({ year: 2026, month: 1 })).toBe("2026-01-01");
        expect(periodLastDayIso({ year: 2026, month: 1 })).toBe("2026-01-31");
        expect(periodLastDayIso({ year: 2026, month: 4 })).toBe("2026-04-30");
        expect(periodLastDayIso({ year: 2026, month: 2 })).toBe("2026-02-28");
        expect(periodLastDayIso({ year: 2026, month: 12 })).toBe("2026-12-31");
    });

    it("febrero bisiesto (incluye la regla de los siglos)", () => {
        expect(periodLastDayIso({ year: 2024, month: 2 })).toBe("2024-02-29");
        expect(periodLastDayIso({ year: 2000, month: 2 })).toBe("2000-02-29");
        expect(periodLastDayIso({ year: 2100, month: 2 })).toBe("2100-02-28");
    });
});

describe("checkVoucherDate — ventas", () => {
    it.each([["2026-05-01"], ["2026-05-15"], ["2026-05-31"]])("%s dentro del período -> ok sin advertencias", (iso) => {
        expect(checkVoucherDate("SALES", d(iso), MAY_2026)).toEqual({ ok: true, warnings: [] });
    });

    it.each([["2026-04-30"], ["2026-06-01"], ["2025-05-15"], ["1999-12-31"]])("%s fuera del período -> error en date", (iso) => {
        const r = checkVoucherDate("SALES", d(iso), MAY_2026);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.field).toBe("date");
            expect(r.error).toBe("la fecha de una venta debe pertenecer al período 05/2026");
        }
    });
});

describe("checkVoucherDate — compras", () => {
    it.each([["2026-05-01"], ["2026-05-31"]])("%s dentro del período -> ok sin advertencias", (iso) => {
        expect(checkVoucherDate("PURCHASES", d(iso), MAY_2026)).toEqual({ ok: true, warnings: [] });
    });

    it("posterior al último día del período -> error en date", () => {
        const r = checkVoucherDate("PURCHASES", d("2026-06-01"), MAY_2026);
        expect(r).toEqual({
            ok: false,
            field: "date",
            error: "la fecha de una compra no puede ser posterior al último día del período (31/05/2026)",
        });
    });

    it("de un período anterior -> ok con advertencia PURCHASE_PRIOR_PERIOD", () => {
        const r = checkVoucherDate("PURCHASES", d("2026-04-30"), MAY_2026);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.warnings).toHaveLength(1);
            expect(r.warnings[0].code).toBe("PURCHASE_PRIOR_PERIOD");
            expect(r.warnings[0].message).toBe(
                "El comprobante es de 04/2026, anterior al período 05/2026; se registra en 05/2026.",
            );
        }
    });

    it("año anterior también advierte", () => {
        const r = checkVoucherDate("PURCHASES", d("2025-12-31"), { year: 2026, month: 1 });
        expect(r.ok && r.warnings[0]?.code).toBe("PURCHASE_PRIOR_PERIOD");
    });

    it("sin límite de antigüedad: 1999-12-31 en 05/2026 -> ok con PURCHASE_PRIOR_PERIOD", () => {
        const r = checkVoucherDate("PURCHASES", d("1999-12-31"), MAY_2026);
        expect(r).toEqual({
            ok: true,
            warnings: [
                {
                    code: "PURCHASE_PRIOR_PERIOD",
                    message: "El comprobante es de 12/1999, anterior al período 05/2026; se registra en 05/2026.",
                },
            ],
        });
    });

    it("29/02 de un año bisiesto es el último día válido", () => {
        expect(checkVoucherDate("PURCHASES", d("2024-02-29"), { year: 2024, month: 2 }).ok).toBe(true);
        expect(checkVoucherDate("SALES", d("2024-02-29"), { year: 2024, month: 2 }).ok).toBe(true);
    });
});

describe("checkVoucherDate — reglas comunes", () => {
    it("no hay fecha mínima global: sólo cuenta la relación con el período", () => {
        expect(Object.keys(rules).filter((k) => /MIN/i.test(k))).toEqual([]);
        expect(checkVoucherDate("SALES", d("1999-12-15"), { year: 1999, month: 12 }).ok).toBe(true);
        expect(checkVoucherDate("PURCHASES", d("1999-12-15"), { year: 1999, month: 12 })).toEqual({
            ok: true,
            warnings: [],
        });
    });

    it("usa el día calendario UTC, el mismo que persiste @db.Date", () => {
        // 31/05 23:30 en -03:00 es 01/06 en UTC: queda fuera de 05/2026.
        expect(checkVoucherDate("SALES", d("2026-05-31T23:30:00-03:00"), MAY_2026).ok).toBe(false);
        expect(checkVoucherDate("SALES", d("2026-05-31T23:30:00Z"), MAY_2026).ok).toBe(true);
    });
});

describe("duplicateVoucherWhere — misma clave que los índices únicos parciales", () => {
    const base: VoucherIdentity = {
        organizationId: "org_a",
        clientId: "c_a",
        category: "SALES",
        voucherCode: 1,
        pointOfSale: 3,
        number: 1001,
        counterpartyDocType: 80,
        counterpartyDocNumber: "30999999995",
    };

    it("ventas: (clientId, voucherCode, pointOfSale, number) + organización; sin contraparte ni período", () => {
        expect(duplicateVoucherWhere(base)).toEqual({
            organizationId: "org_a",
            clientId: "c_a",
            category: "SALES",
            voucherCode: 1,
            pointOfSale: 3,
            number: 1001,
        });
    });

    it("compras: agrega counterpartyDocType y counterpartyDocNumber", () => {
        expect(duplicateVoucherWhere({ ...base, category: "PURCHASES" })).toEqual({
            organizationId: "org_a",
            clientId: "c_a",
            category: "PURCHASES",
            voucherCode: 1,
            pointOfSale: 3,
            number: 1001,
            counterpartyDocType: 80,
            counterpartyDocNumber: "30999999995",
        });
    });

    it("nunca filtra por período: la duplicidad es entre todos los períodos del cliente", () => {
        expect(duplicateVoucherWhere(base)).not.toHaveProperty("periodId");
        expect(duplicateVoucherWhere({ ...base, category: "PURCHASES" })).not.toHaveProperty("periodId");
    });

    it("edición: excluye al propio comprobante", () => {
        expect(duplicateVoucherWhere(base, "inv_1").NOT).toEqual({ id: "inv_1" });
        expect(duplicateVoucherWhere(base)).not.toHaveProperty("NOT");
    });

    it("mensaje: sólo el período MM/AAAA", () => {
        expect(duplicateVoucherMessage({ year: 2026, month: 4 })).toBe("El comprobante ya existe en el período 04/2026.");
    });
});
