import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { planTributeSync, syncUpdateData, TRIBUTE_FIELDS, type SyncInvoice, type Tributes } from "@/lib/libro-iva-import/tribute-sync";

// Datos sintéticos.
const d = (v: string) => new Prisma.Decimal(v);
const T = (o: Partial<Record<(typeof TRIBUTE_FIELDS)[number], string>>): Tributes =>
    Object.fromEntries(TRIBUTE_FIELDS.map((f) => [f, d(o[f] ?? "0")])) as Tributes;
const inv = (id: string, key: string, cuit: string, t: Tributes): SyncInvoice => ({
    id, key, counterpartyDocNumber: cuit, counterpartyName: `Proveedor ${cuit.slice(-3)}`, pointOfSale: 24, number: Number(id.replace(/\D/g, "")) || 1, voucherCode: 1, tributes: t,
});

describe("Sincronización de tributos de compras con el Libro IVA Digital", () => {
    it("percepción de IIBB que en realidad era impuestos internos: se separa según el LID (el total no cambia)", () => {
        const items = planTributeSync(
            [{ key: "k1", tributes: T({ vatPerceptionAmount: "8077.84", iibbPerceptionAmount: "4038.92", internalTaxesAmount: "33516.11" }) }],
            [inv("i1", "k1", "30999999993", T({ vatPerceptionAmount: "8077.84", iibbPerceptionAmount: "37555.03" }))],
            new Set(),
        );
        expect(items).toHaveLength(1);
        expect(items[0].applicable).toBe(true);
        expect(syncUpdateData(items[0])).toEqual({ iibbPerceptionAmount: d("4038.92"), internalTaxesAmount: d("33516.11") });
    });

    it("sin diferencias: no aparece; proveedor excluido: se informa pero queda marcado", () => {
        const same = T({ iibbPerceptionAmount: "100" });
        expect(planTributeSync([{ key: "k", tributes: same }], [inv("i1", "k", "30999999993", same)], new Set())).toEqual([]);
        const items = planTributeSync(
            [{ key: "k", tributes: T({ nationalPerceptionAmount: "100" }) }],
            [inv("i1", "k", "30999999993", T({ iibbPerceptionAmount: "100" }))],
            new Set(["30999999993"]),
        );
        expect(items[0]).toMatchObject({ applicable: true, excluded: true });
    });

    it("si la suma de tributos difiere (otro total), no se aplica y se explica", () => {
        const [it0] = planTributeSync(
            [{ key: "k", tributes: T({ internalTaxesAmount: "1217177.28" }) }],
            [inv("i1", "k", "30999999993", T({ nonTaxedAmount: "1217177.22" }))],
            new Set(),
        );
        expect(it0.applicable).toBe(false);
        expect(it0.reason).toMatch(/difiere en 0\.06/);
    });

    it("comprobante del archivo sin compra cargada en el período: se ignora", () => {
        expect(planTributeSync([{ key: "otro", tributes: T({ iibbPerceptionAmount: "1" }) }], [inv("i1", "k", "30999999993", T({}))], new Set())).toEqual([]);
    });
});
