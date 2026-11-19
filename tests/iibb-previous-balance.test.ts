import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { previousIibbBalance, iibbPositionWithPrevious } from "@/lib/iibb-previous-balance";

// Datos sintéticos.
const d = (v: string) => new Prisma.Decimal(v);
function db(row: unknown) {
    const calls: unknown[] = [];
    return { calls, db: { period: { findFirst: async (args: unknown) => { calls.push(args); return row; } } } as never };
}

describe("saldo a favor de IIBB del período anterior (automático)", () => {
    it("toma el saldo a favor del contribuyente de la liquidación cerrada; enero busca diciembre del año anterior", async () => {
        const m = db({ status: "CLOSED", iibbPosition: null, liquidationVersions: [{ summary: { liquidation: { iibb: { balanceTaxpayer: "754164.22" } } } }] });
        const r = await previousIibbBalance(m.db, { organizationId: "o", clientId: "c", month: 1, year: 2027 });
        expect(r).toMatchObject({ source: "closed", month: 12, year: 2026 });
        expect(r!.amount.toFixed(2)).toBe("754164.22");
        expect(m.calls[0]).toMatchObject({ where: { organizationId: "o", clientId: "c", month: 12, year: 2026 } });
    });

    it("cierre anterior a la estructura de la DDJJ: usa el saldo de la DDJJ presentada registrada", async () => {
        const m = db({ status: "CLOSED", iibbPosition: { filedBalanceTaxpayer: d("100.50") }, liquidationVersions: [{ summary: { liquidation: { iibb: { payable: "1.00" } } } }] });
        expect(await previousIibbBalance(m.db, { organizationId: "o", clientId: "c", month: 11, year: 2026 })).toMatchObject({ source: "filed", month: 10 });
    });

    it("período anterior abierto sin DDJJ registrada, o inexistente: sin saldo automático", async () => {
        expect(await previousIibbBalance(db({ status: "OPEN", iibbPosition: null, liquidationVersions: [] }).db, { organizationId: "o", clientId: "c", month: 11, year: 2026 })).toBeNull();
        expect(await previousIibbBalance(db(null).db, { organizationId: "o", clientId: "c", month: 11, year: 2026 })).toBeNull();
    });

    it("lo cargado a mano prevalece sobre el automático", () => {
        const saved = { previousBalance: d("5"), paymentsOnAccount: d("0"), otherCredits: d("0"), otherDebits: d("0") };
        expect(iibbPositionWithPrevious(saved, { amount: d("9"), source: "closed", month: 9, year: 2026 })).toBe(saved);
        expect(iibbPositionWithPrevious(null, { amount: d("9"), source: "closed", month: 9, year: 2026 })!.previousBalance.toFixed(2)).toBe("9.00");
        expect(iibbPositionWithPrevious(null, null)).toBeNull();
    });
});
