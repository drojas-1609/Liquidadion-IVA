import { describe, expect, it } from "vitest";
import { invoiceSearchWhere, normalizeSearch, parseSearchAmount } from "@/lib/invoice-search";

const ors = (text: string) => invoiceSearchWhere(text)?.OR ?? [];

describe("buscador de comprobantes", () => {
    it("normaliza el texto y lo acota", () => {
        expect(normalizeSearch("  DISTRIBUIDORA   FERRARI ")).toBe("DISTRIBUIDORA FERRARI");
        expect(normalizeSearch(["7-13442", "x"])).toBe("7-13442");
        expect(normalizeSearch(undefined)).toBe("");
        expect(normalizeSearch("x".repeat(100))).toHaveLength(60);
    });

    it("sin texto suficiente no filtra", () => {
        expect(invoiceSearchWhere("")).toBeNull();
        expect(invoiceSearchWhere("a")).toBeNull();
    });

    it("razón social: contiene, sin distinguir mayúsculas", () => {
        expect(ors("ferrari")).toEqual([{ counterpartyName: { contains: "ferrari", mode: "insensitive" } }]);
    });

    it("comprobante PV-número, con o sin ceros", () => {
        expect(ors("00007-00013442")).toContainEqual({ pointOfSale: 7, number: 13442 });
        expect(ors("7-13442")).toContainEqual({ pointOfSale: 7, number: 13442 });
        expect(ors("7-13442")).not.toContainEqual({ number: 713442 });
    });

    it("sólo dígitos: número de comprobante y CUIT", () => {
        expect(ors("13442")).toContainEqual({ number: 13442 });
        expect(ors("13442")).toContainEqual({ counterpartyDocNumber: { contains: "13442" } });
        expect(ors("30-71210817-3")).toContainEqual({ counterpartyDocNumber: { contains: "30712108173" } });
        expect(ors("30712108173")).not.toContainEqual({ number: 30712108173 });
    });

    it("importes en formato argentino o con punto decimal", () => {
        expect(parseSearchAmount("909.799,99")?.toFixed(2)).toBe("909799.99");
        expect(parseSearchAmount("$ 909.799,99")?.toFixed(2)).toBe("909799.99");
        expect(parseSearchAmount("909799,99")?.toFixed(2)).toBe("909799.99");
        expect(parseSearchAmount("909799.99")?.toFixed(2)).toBe("909799.99");
        expect(parseSearchAmount("909799")).toBeNull();
        const amount = ors("909.799,99").find((o) => "totalAmount" in o) as { totalAmount: { in: { toFixed(n: number): string }[] } };
        expect(amount.totalAmount.in.map((d) => d.toFixed(2))).toEqual(["909799.99", "-909799.99"]);
    });
});
