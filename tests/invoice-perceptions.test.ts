import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Prisma } from "@prisma/client";
import { planInvoicePerceptions, planOtherTaxesSplit, sameVoucherNumber, IVA_PERCEPTION_TYPE, IIBB_PERCEPTION_TYPE, type OtherTaxesInvoice, type PerceptionInvoice, type PerceptionRecord } from "@/lib/invoice-perceptions";

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

describe("separación de «Otros tributos» de las compras", () => {
    const other = (over: Partial<OtherTaxesInvoice> = {}): OtherTaxesInvoice => ({
        ...inv({ vatPerceptionAmount: d("0.00") }), otherTaxesAmount: d("1000.00"), internalTaxesAmount: d("0.00"), ...over,
    });
    const arca = (amount: string) => rec({ amount: d(amount) });

    it("separa la percepción de IVA informada por ARCA; el resto queda sin regla", () => {
        const [s] = planOtherTaxesSplit([other()], [arca("300.00")], new Map());
        expect(s.vatPerceptionAmount.toFixed(2)).toBe("300.00");
        expect(s.otherTaxesAmount.toFixed(2)).toBe("700.00");
        expect(s.iibbPerceptionAmount.toFixed(2)).toBe("0.00");
    });

    it("con regla IIBB, el resto pasa a percepción de IIBB (el total no cambia)", () => {
        const [s] = planOtherTaxesSplit([other()], [arca("300.00")], new Map([[AGENT, "IIBB_PERCEPTION"]]));
        expect([s.vatPerceptionAmount, s.iibbPerceptionAmount, s.otherTaxesAmount, s.internalTaxesAmount].map((x) => x.toFixed(2))).toEqual(["300.00", "700.00", "0.00", "0.00"]);
    });

    it("con regla de impuestos internos, se suma a los internos existentes", () => {
        const [s] = planOtherTaxesSplit([other({ internalTaxesAmount: d("50.00") })], [], new Map([[AGENT, "INTERNAL_TAXES"]]));
        expect(s.internalTaxesAmount.toFixed(2)).toBe("1050.00");
        expect(s.otherTaxesAmount.toFixed(2)).toBe("0.00");
    });

    it("regla OTHER o sin datos de ARCA: no cambia nada", () => {
        expect(planOtherTaxesSplit([other()], [], new Map([[AGENT, "OTHER"]]))).toEqual([]);
        expect(planOtherTaxesSplit([other()], [], new Map())).toEqual([]);
    });

    it("la percepción de ARCA mayor que «Otros tributos» no se separa", () => {
        expect(planOtherTaxesSplit([other({ otherTaxesAmount: d("100.00") })], [arca("300.00")], new Map())).toEqual([]);
    });

    it("con percepción de IVA ya cargada no la toca; sí imputa el resto por regla", () => {
        const [s] = planOtherTaxesSplit([other({ vatPerceptionAmount: d("21985.02"), otherTaxesAmount: d("40.00") })], [arca("22011.29")], new Map([[AGENT, "IIBB_PERCEPTION"]]));
        expect(s.vatPerceptionAmount.toFixed(2)).toBe("21985.02");
        expect(s.iibbPerceptionAmount.toFixed(2)).toBe("40.00");
    });

    it("es idempotente: ya separada, no hay cambios", () => {
        const done = other({ vatPerceptionAmount: d("300.00"), otherTaxesAmount: d("0.00"), iibbPerceptionAmount: d("700.00") });
        expect(planOtherTaxesSplit([done], [arca("300.00")], new Map([[AGENT, "IIBB_PERCEPTION"]]))).toEqual([]);
    });

    it("notas de crédito: sin regla no se separan, y nunca toman la percepción de IVA de ARCA", () => {
        expect(planOtherTaxesSplit([other({ voucherCode: 3 })], [arca("300.00")], new Map())).toEqual([]);
        const [s] = planOtherTaxesSplit([other({ voucherCode: 3 })], [arca("300.00")], new Map([[AGENT, "IIBB_PERCEPTION"]]));
        expect(s.vatPerceptionAmount.toFixed(2)).toBe("0.00");
        expect(s.iibbPerceptionAmount.toFixed(2)).toBe("1000.00");
        expect(s.otherTaxesAmount.toFixed(2)).toBe("0.00");
    });
});

describe("notas de crédito: la percepción de IIBB resta (criterio del estudio)", () => {
    const nc = (over: Partial<PerceptionInvoice> = {}) => inv({ id: "nc1", voucherCode: 3, vatPerceptionAmount: null, iibbPerceptionAmount: d("525.62"), ...over });

    it("crea el registro de IIBB con importe negativo, a la jurisdicción sede", () => {
        const [a] = planInvoicePerceptions([nc()], [], "901");
        expect(a).toMatchObject({ kind: "create", invoiceId: "nc1", type: IIBB_PERCEPTION_TYPE, jurisdictionCode: "901" });
        expect(a.kind === "create" && a.amount.toFixed(2)).toBe("-525.62");
    });

    it("idempotente: con el registro negativo ya creado no hay cambios", () => {
        const done = rec({ id: "t1", type: IIBB_PERCEPTION_TYPE, nature: null, amount: d("-525.62"), invoiceId: "nc1", fromInvoice: true, jurisdictionCode: "901" });
        expect(planInvoicePerceptions([nc()], [done], "901")).toEqual([]);
    });

    it("si cambia el importe de la NC, actualiza con signo negativo", () => {
        const done = rec({ id: "t1", type: IIBB_PERCEPTION_TYPE, nature: null, amount: d("-525.62"), invoiceId: "nc1", fromInvoice: true, jurisdictionCode: "901" });
        const [a] = planInvoicePerceptions([nc({ iibbPerceptionAmount: d("500.00") })], [done], "901");
        expect(a.kind === "update" && a.amount.toFixed(2)).toBe("-500.00");
    });

    it("la percepción de IVA de una NC no se registra (tabla del F.2051: facturas y notas de débito)", () => {
        expect(planInvoicePerceptions([nc({ vatPerceptionAmount: d("100.00"), iibbPerceptionAmount: null })], [], "901")).toEqual([]);
    });
});

describe("IIBB informada por el fisco (lib/iibb-import): reemplaza a la tomada del comprobante", () => {
    // Factura A 0004-00488105 del agente, con percepción de IIBB cargada.
    const factura = (over: Partial<PerceptionInvoice> = {}) => inv({ id: "f1", voucherCode: 1, pointOfSale: 4, number: 488105, vatPerceptionAmount: null, iibbPerceptionAmount: d("35219.82"), ...over });
    const informada = (over: Partial<PerceptionRecord> = {}) => rec({
        id: "imp1", type: IIBB_PERCEPTION_TYPE, nature: null, amount: d("35219.82"), voucherNumber: "04170000488105",
        jurisdictionCode: "901", importSource: "RENTAS_CIUDAD_PERCEPCIONES", voucherKind: "F", ...over,
    });
    const tomada = rec({ id: "inv-rec", type: IIBB_PERCEPTION_TYPE, nature: null, amount: d("35219.82"), voucherNumber: null, invoiceId: "f1", fromInvoice: true, jurisdictionCode: "920" });

    it("sin registro previo: se vincula la informada (no se crea otra)", () => {
        expect(planInvoicePerceptions([factura()], [informada()], "920")).toEqual([{ kind: "link", recordId: "imp1", invoiceId: "f1" }]);
    });

    it("con la tomada del comprobante: se borra y se vincula la informada (aunque el importe difiera)", () => {
        expect(planInvoicePerceptions([factura()], [tomada, informada({ amount: d("35000.00") })], "920")).toEqual([
            { kind: "delete", recordId: "inv-rec" },
            { kind: "link", recordId: "imp1", invoiceId: "f1" },
        ]);
    });

    it("idempotente: con la informada ya vinculada no hay cambios", () => {
        expect(planInvoicePerceptions([factura()], [informada({ invoiceId: "f1" })], "920")).toEqual([]);
    });

    it("otro agente, otro número o nota de crédito contra factura: no se vincula", () => {
        const create = { kind: "create", invoiceId: "f1", type: IIBB_PERCEPTION_TYPE };
        expect(planInvoicePerceptions([factura()], [informada({ agentCuit: "30888888885" })], "920")[0]).toMatchObject(create);
        expect(planInvoicePerceptions([factura()], [informada({ voucherNumber: "04170000488106" })], "920")[0]).toMatchObject(create);
        expect(planInvoicePerceptions([factura()], [informada({ voucherKind: "C" })], "920")[0]).toMatchObject(create);
    });

    it("dos informadas candidatas: no elige (queda la del comprobante)", () => {
        expect(planInvoicePerceptions([factura()], [tomada, informada(), informada({ id: "imp2" })], "920")).toEqual([]);
    });

    it("nota de crédito con la informada «C»: se vincula", () => {
        const nc = factura({ id: "nc1", voucherCode: 3, iibbPerceptionAmount: d("525.62"), number: 15790 });
        expect(planInvoicePerceptions([nc], [informada({ voucherNumber: "00015790", voucherKind: "C", amount: d("-525.62") })], "920")).toEqual([{ kind: "link", recordId: "imp1", invoiceId: "nc1" }]);
    });

    it("informada SIN número (descarga de ASIP): misma fecha e importe (±0,05) → se vincula; si el importe difiere, no", () => {
        const sinNumero = (over: Partial<PerceptionRecord> = {}) => informada({ voucherNumber: null, importSource: "SANTA_CRUZ_PERCEPCIONES", jurisdictionCode: "920", ...over });
        expect(planInvoicePerceptions([factura()], [tomada, sinNumero({ amount: d("35219.77") })], "920")).toEqual([
            { kind: "delete", recordId: "inv-rec" },
            { kind: "link", recordId: "imp1", invoiceId: "f1" },
        ]);
        expect(planInvoicePerceptions([factura()], [tomada, sinNumero({ amount: d("35219.70") })], "920")).toEqual([]);
        expect(planInvoicePerceptions([factura()], [tomada, sinNumero({ date: new Date("2026-10-02T00:00:00Z") })], "920")).toEqual([]);
    });

    it("si la compra deja de tener la percepción, la informada se desvincula (no se borra)", () => {
        expect(planInvoicePerceptions([factura({ iibbPerceptionAmount: null })], [informada({ invoiceId: "f1" })], "920")).toEqual([{ kind: "unlink", recordId: "imp1" }]);
    });
});
