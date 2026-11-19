import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { buildF5680, f5680Amount, type F5680Record } from "@/lib/iibb-export/f5680";

// Datos sintéticos (CUIT y CBU ficticios).
const d = (v: string) => new Prisma.Decimal(v);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const base = (o: Partial<F5680Record>): F5680Record => ({
    id: "r", type: "PERCEPCION IIBB", date: day("2026-10-13"), amount: d("282.63"), agentCuit: "30999999993",
    voucherNumber: null, pointOfSale: null, voucherKind: null, voucherLetter: null, certificateNumber: null, cbu: null, invoice: null, ...o,
});

describe("F.5680 Santa Cruz: archivos de importación", () => {
    it("importe: 15 caracteres, coma decimal, negativo con el signo adelante", () => {
        expect(f5680Amount(d("282.63"))).toBe("000000000282,63");
        expect(f5680Amount(d("-525.62"))).toBe("-00000000525,62");
    });

    it("percepción vinculada a una factura A: letra 1, tipo 1, número de la compra (53 caracteres)", () => {
        const r = buildF5680("percepciones", [base({ invoice: { voucherCode: 1, pointOfSale: 15, number: 345804 } })]);
        expect(r.problems).toEqual([]);
        expect(r.lines).toEqual(["13/10/202630999999993110015-00345804  000000000282,63"]);
        expect(r.lines[0]).toHaveLength(53);
    });

    it("nota de crédito A: tipo 3 e importe negativo", () => {
        const r = buildF5680("percepciones", [base({ amount: d("-525.62"), invoice: { voucherCode: 3, pointOfSale: 15, number: 15790 } })]);
        expect(r.lines).toEqual(["13/10/202630999999993130015-00015790  -00000000525,62"]);
    });

    it("sin compra vinculada ni número: no se escribe y se informa el motivo", () => {
        const r = buildF5680("percepciones", [base({ voucherKind: "F", voucherLetter: "A" })]);
        expect(r.lines).toEqual([]);
        expect(r.problems[0].reason).toMatch(/número de comprobante/);
    });

    it("retenciones (incluye SIRTAC) y bancarias (SIRCREB)", () => {
        const ret = buildF5680("retenciones", [
            base({ type: "RETENCION IIBB", certificateNumber: "000000000761280", amount: d("22.50"), date: day("2026-10-30") }),
            base({ type: "SIRTAC", certificateNumber: "183587726473", amount: d("12271.50"), date: day("2026-10-31") }),
            base({ type: "SIRCREB", cbu: "0110000100000000000001" }),
        ]);
        expect(ret.lines).toEqual([
            "30/10/202630999999993000000000761280000000000022,50",
            "31/10/202630999999993000183587726473000000012271,50",
        ]);
        expect(ret.total.toFixed(2)).toBe("12294.00");
        const banc = buildF5680("bancarias", [base({ type: "SIRCREB", cbu: "0110000100000000000001", amount: d("24157.65"), date: day("2026-10-31") })]);
        expect(banc.lines).toEqual(["2026100110000100000000000001000000024157,65"]);
    });
});
