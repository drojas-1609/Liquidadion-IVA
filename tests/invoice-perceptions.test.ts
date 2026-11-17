import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Prisma } from "@prisma/client";
import { planInvoicePerceptions, sameVoucherNumber, IVA_PERCEPTION_TYPE, IIBB_PERCEPTION_TYPE, type PerceptionInvoice, type PerceptionRecord } from "@/lib/invoice-perceptions";

const d = (v: string) => new Prisma.Decimal(v);
const day = new Date("2026-10-16T00:00:00.000Z");
// Datos sintéticos (CUIT de prueba).
const AGENT = "30999999993";

function inv(over: Partial<PerceptionInvoice> = {}): PerceptionInvoice {
    return {
        id: "inv1", voucherCode: 81, pointOfSale: 7, number: 13442, voucherDate: day, date: day,
        counterpartyDocType: 80, counterpartyDocNumber: AGENT, vatPerceptionAmount: d("21985.02"), iibbPerceptionAmount: null, ...over,
    };
}
function rec(over: Partial<PerceptionRecord> = {}): PerceptionRecord {
    return {
        id: "rec1", type: IVA_PERCEPTION_TYPE, nature: "PERCEPTION", amount: d("22011.29"), agentCuit: AGENT,
        voucherNumber: "0007000000013442", invoiceId: null, fromInvoice: false, jurisdictionCode: null, date: day, ...over,
    };
}

describe("número de comprobante informado por ARCA", () => {
    it("acepta distintos rellenos de ceros", () => {
        expect(sameVoucherNumber("0007000000013442", 7, 13442)).toBe(true);
        expect(sameVoucherNumber("00007-00013442", 7, 13442)).toBe(true);
        expect(sameVoucherNumber("000700013442", 7, 13442)).toBe(true);
    });
    it("rechaza otro número o texto", () => {
        expect(sameVoucherNumber("0007000000013443", 7, 13442)).toBe(false);
        expect(sameVoucherNumber("0008000000013442", 7, 13442)).toBe(false);
        expect(sameVoucherNumber("A-13442", 7, 13442)).toBe(false);
        expect(sameVoucherNumber(null, 7, 13442)).toBe(false);
    });
});

describe("conciliación de percepciones de las compras", () => {
    it("IVA ya informada por ARCA: se vincula, sin crear nada (aunque el importe difiera)", () => {
        expect(planInvoicePerceptions([inv()], [rec()], "902")).toEqual([{ kind: "link", recordId: "rec1", invoiceId: "inv1" }]);
    });

    it("IVA sin registro de ARCA: se crea desde el comprobante con el formato del F.2051", () => {
        const [a] = planInvoicePerceptions([inv()], [], "902");
        expect(a).toMatchObject({ kind: "create", invoiceId: "inv1", type: IVA_PERCEPTION_TYPE, agentCuit: AGENT, voucherTypeCode: 1, voucherNumber: "00007-00013442", jurisdictionCode: null });
        expect((a as { amount: Prisma.Decimal }).amount.toFixed(2)).toBe("21985.02");
    });

    it("la de ARCA llega después: reemplaza a la tomada del comprobante", () => {
        const fromInvoice = rec({ id: "own", invoiceId: "inv1", fromInvoice: true, amount: d("21985.02"), voucherNumber: "00007-00013442" });
        expect(planInvoicePerceptions([inv()], [fromInvoice, rec()], null)).toEqual([
            { kind: "delete", recordId: "own" },
            { kind: "link", recordId: "rec1", invoiceId: "inv1" },
        ]);
    });

    it("ya vinculada a ARCA: no cambia nada (idempotente)", () => {
        expect(planInvoicePerceptions([inv()], [rec({ invoiceId: "inv1" })], null)).toEqual([]);
    });

    it("tomada del comprobante: sigue al importe del comprobante", () => {
        const own = rec({ id: "own", invoiceId: "inv1", fromInvoice: true, amount: d("100.00"), agentCuit: AGENT, voucherNumber: "00007-00013442" });
        const [a] = planInvoicePerceptions([inv()], [own], null);
        expect(a).toMatchObject({ kind: "update", recordId: "own" });
        expect((a as { amount: Prisma.Decimal }).amount.toFixed(2)).toBe("21985.02");
    });

    it("otro agente u otro comprobante no se vinculan", () => {
        expect(planInvoicePerceptions([inv()], [rec({ agentCuit: "30888888886" })], null)[0].kind).toBe("create");
        expect(planInvoicePerceptions([inv()], [rec({ voucherNumber: "0007000000099999" })], null)[0].kind).toBe("create");
    });

    it("dos percepciones de ARCA candidatas: no elige ni crea", () => {
        expect(planInvoicePerceptions([inv()], [rec(), rec({ id: "rec2" })], null)).toEqual([]);
    });

    it("IIBB: se crea con la jurisdicción sede", () => {
        const [a] = planInvoicePerceptions([inv({ vatPerceptionAmount: null, iibbPerceptionAmount: d("500.00") })], [], "902");
        expect(a).toMatchObject({ kind: "create", type: IIBB_PERCEPTION_TYPE, jurisdictionCode: "902" });
    });

    it("IVA e IIBB del mismo comprobante: dos registros", () => {
        const kinds = planInvoicePerceptions([inv({ iibbPerceptionAmount: d("500.00") })], [], "902").map((a) => a.kind === "create" ? a.type : a.kind);
        expect(kinds).toEqual([IVA_PERCEPTION_TYPE, IIBB_PERCEPTION_TYPE]);
    });

    it("notas de crédito: no se registra nada automáticamente", () => {
        expect(planInvoicePerceptions([inv({ voucherCode: 3 })], [], "902")).toEqual([]);
    });

    it("el comprobante ya no tiene la percepción: la tomada se borra y la de ARCA se desvincula", () => {
        const plan = planInvoicePerceptions(
            [inv({ vatPerceptionAmount: null })],
            [rec({ invoiceId: "inv1" }), rec({ id: "own", type: IIBB_PERCEPTION_TYPE, invoiceId: "inv1", fromInvoice: true })],
            null,
        );
        expect(plan).toEqual([{ kind: "unlink", recordId: "rec1" }, { kind: "delete", recordId: "own" }]);
    });
});
