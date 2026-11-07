import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { buildDetailedModel, detailedChangedFields, parseDetailedEditBody, type DetailedIdentity } from "@/lib/invoice-detail-edit";
import { detailedEditability } from "@/lib/invoice-edit";

const D = (v: string) => new Prisma.Decimal(v);
const T0 = "2027-10-20T12:00:00.000Z";
const P = { month: 10, year: 2027 };
const NONE = { creditProrationMode: "NONE", globalCoefficient: null };
const zeroAmounts = {
    netWithoutVatBreakdownAmount: "0", nonTaxedAmount: "0", exemptAmount: "0", vatPerceptionAmount: "0", nationalPerceptionAmount: "0",
    iibbPerceptionAmount: "0", municipalPerceptionAmount: "0", internalTaxesAmount: "0", otherTaxesAmount: "0", turivaRefundAmount: "0",
};
const idOf = (o: Partial<DetailedIdentity> = {}): DetailedIdentity => ({
    category: "PURCHASES", voucherCode: 1, pointOfSale: 7, number: 31, counterpartyDocType: 80, counterpartyDocNumber: "30711111111",
    lidSection: "GENERAL", currencyCode: "PES", exchangeRate: D("1"), ...o,
});
const body = (o: Record<string, unknown> = {}) => ({
    contract: "DETAILED_V1",
    expectedUpdatedAt: T0,
    voucherDate: "2027-10-03",
    counterpartyName: "PROVEEDOR SINTETICO SRL",
    counterpartyVatConditionCode: null,
    operationCode: null,
    amounts: { ...zeroAmounts, otherTaxesAmount: "30.00", exemptAmount: "45.00" },
    reportedComputableVatCreditAmount: "315.00",
    vatLines: [
        { vatRateCode: 5, netAmount: "1000.00", vatAmount: "210.00", creditAllocation: "DIRECT_COMPUTABLE", computableVatAmount: "210.00" },
        { vatRateCode: 4, netAmount: "1000.00", vatAmount: "105.00", creditAllocation: "DIRECT_COMPUTABLE", computableVatAmount: "105.00" },
    ],
    ...o,
});
const parse = (o: Record<string, unknown> = {}) => {
    const r = parseDetailedEditBody(body(o));
    if (!r.ok) throw new Error(`${r.field}: ${r.error}`);
    return r.data;
};

describe("corrección detallada de importados: forma del cuerpo", () => {
    it("la identidad y las clasificaciones no viajan: cualquier otra clave se rechaza (nunca se ignora en silencio)", () => {
        for (const k of ["voucherCode", "pointOfSale", "number", "counterpartyDocNumber", "activityCode", "source", "periodId"]) {
            const r = parseDetailedEditBody({ ...body(), [k]: 1 });
            expect(r.ok ? null : r.field).toBe(k);
        }
        expect(parseDetailedEditBody({ ...body(), contract: undefined }).ok).toBe(false);
    });

    it("importes negativos, con más de 2 decimales o alícuota fuera de la tabla -> rechazo con el campo", () => {
        const a = parseDetailedEditBody(body({ amounts: { ...zeroAmounts, exemptAmount: "-1" } }));
        expect(a.ok ? null : a.field).toBe("exemptAmount");
        const b = parseDetailedEditBody(body({ vatLines: [{ vatRateCode: 99, netAmount: "1", vatAmount: "0", creditAllocation: "DIRECT_COMPUTABLE", computableVatAmount: "0" }] }));
        expect(b.ok ? null : b.field).toBe("vatLines.0.vatRateCode");
        const c = parseDetailedEditBody(body({ amounts: { ...zeroAmounts, otherTaxesAmount: "1.234" } }));
        expect(c.ok ? null : c.field).toBe("otherTaxesAmount");
    });
});

describe("corrección detallada de importados: reglas de la importación", () => {
    it("conserva TODO: dos alícuotas, exento, otros tributos, crédito informado; total recalculado", () => {
        const r = buildDetailedModel(idOf(), parse(), P, NONE);
        if (!r.ok) throw new Error(r.error);
        expect(r.model.vatLines.map((l) => [l.vatRateCode, l.netAmount.toFixed(2), l.vatAmount.toFixed(2), l.computableVatAmount?.toFixed(2)])).toEqual([[5, "1000.00", "210.00", "210.00"], [4, "1000.00", "105.00", "105.00"]]);
        expect([r.model.taxedNetAmount, r.model.totalVatAmount, r.model.exemptAmount, r.model.otherTaxesAmount, r.model.voucherTotalAmount, r.model.directComputableVatCreditAmount].map((x) => x.toFixed(2)))
            .toEqual(["2000.00", "315.00", "45.00", "30.00", "2390.00", "315.00"]);
        // «Otros tributos» sigue siendo otros tributos: nunca se convierte en percepción de IVA.
        expect(r.model.vatPerceptionAmount.toFixed(2)).toBe("0.00");
        // Identidad intacta.
        expect([r.model.voucherCode, r.model.pointOfSale, r.model.number, r.model.counterpartyDocNumber]).toEqual([1, 7, 31, "30711111111"]);
    });

    it("IVA que no corresponde a la alícuota (más de 0,01) -> rechazo", () => {
        const r = buildDetailedModel(idOf(), parse({ vatLines: [{ vatRateCode: 5, netAmount: "1000.00", vatAmount: "209.98", creditAllocation: "DIRECT_COMPUTABLE", computableVatAmount: "209.98" }] }), P, NONE);
        expect(r.ok ? null : [r.field, r.error]).toEqual(["vatLines.0.vatAmount", expect.stringMatching(/calculado 210\.00/)]);
    });

    it("alícuota 0 % sin código de operación -> rechazo; con código E -> ok", () => {
        const zero = [{ vatRateCode: 3, netAmount: "100.00", vatAmount: "0.00", creditAllocation: "DIRECT_COMPUTABLE", computableVatAmount: "0.00" }];
        const r = buildDetailedModel(idOf(), parse({ vatLines: zero, reportedComputableVatCreditAmount: null }), P, NONE);
        expect(r.ok ? null : r.field).toBe("operationCode");
        expect(buildDetailedModel(idOf(), parse({ vatLines: zero, operationCode: "E", reportedComputableVatCreditAmount: null }), P, NONE).ok).toBe(true);
    });

    it("prorrateo: sin prorrateo el computable es igual al IVA; global sólo con prorrateo global; no computable sólo con prorrateo", () => {
        const partial = [{ vatRateCode: 5, netAmount: "1000.00", vatAmount: "210.00", creditAllocation: "DIRECT_COMPUTABLE", computableVatAmount: "100.00" }];
        const r1 = buildDetailedModel(idOf(), parse({ vatLines: partial, reportedComputableVatCreditAmount: null }), P, NONE);
        expect(r1.ok ? null : r1.field).toBe("vatLines.0.computableVatAmount");
        const r2 = buildDetailedModel(idOf(), parse({ vatLines: partial, reportedComputableVatCreditAmount: null }), P, { creditProrationMode: "DIRECT", globalCoefficient: null });
        expect(r2.ok && r2.model.vatLines[0].computableOverridden).toBe(true);
        const global = [{ vatRateCode: 5, netAmount: "1000.00", vatAmount: "210.00", creditAllocation: "GLOBAL_PRORATION", computableVatAmount: null }];
        expect(buildDetailedModel(idOf(), parse({ vatLines: global, reportedComputableVatCreditAmount: null }), P, { creditProrationMode: "DIRECT", globalCoefficient: null }).ok).toBe(false);
        expect(buildDetailedModel(idOf(), parse({ vatLines: global, reportedComputableVatCreditAmount: null }), P, { creditProrationMode: "GLOBAL", globalCoefficient: D("0.5") }).ok).toBe(true);
        const nonComp = [{ vatRateCode: 5, netAmount: "1000.00", vatAmount: "210.00", creditAllocation: "DIRECT_NON_COMPUTABLE", computableVatAmount: "0" }];
        expect(buildDetailedModel(idOf(), parse({ vatLines: nonComp, reportedComputableVatCreditAmount: null }), P, NONE).ok).toBe(false);
    });

    it("compra B/C: sin líneas y con neto sin discriminar; venta A sin líneas ni exento -> rechazo", () => {
        const b = buildDetailedModel(idOf({ voucherCode: 6 }), parse({ vatLines: [], reportedComputableVatCreditAmount: null, amounts: { ...zeroAmounts, netWithoutVatBreakdownAmount: "45000.00" } }), P, NONE);
        if (!b.ok) throw new Error(b.error);
        expect([b.model.netWithoutVatBreakdownAmount.toFixed(2), b.model.voucherTotalAmount.toFixed(2)]).toEqual(["45000.00", "45000.00"]);
        const withLines = buildDetailedModel(idOf({ voucherCode: 6 }), parse(), P, NONE);
        expect(withLines.ok ? null : withLines.field).toBe("vatLines");
        const saleA = buildDetailedModel(idOf({ category: "SALES" }), parse({ vatLines: [], reportedComputableVatCreditAmount: null, amounts: zeroAmounts }), P, NONE);
        expect(saleA.ok ? null : saleA.field).toBe("vatLines");
        // Venta A sólo exenta (la descarga no trae línea al 0 %): admitida, como en la importación.
        const exempt = buildDetailedModel(idOf({ category: "SALES" }), parse({ vatLines: [], reportedComputableVatCreditAmount: null, amounts: { ...zeroAmounts, exemptAmount: "45000.00" } }), P, NONE);
        expect(exempt.ok && exempt.model.voucherTotalAmount.toFixed(2)).toBe("45000.00");
    });

    it("venta fuera del período -> rechazo; reintegro TurIVA fuera de la pestaña TURIVA -> rechazo", () => {
        const sale = (o: Record<string, unknown>) => parse({ reportedComputableVatCreditAmount: null, vatLines: [{ vatRateCode: 5, netAmount: "100.00", vatAmount: "21.00", creditAllocation: "NOT_APPLICABLE", computableVatAmount: null }], ...o });
        const r = buildDetailedModel(idOf({ category: "SALES" }), sale({ voucherDate: "2027-09-30" }), P, NONE);
        expect(r.ok ? null : r.field).toBe("voucherDate");
        const t = buildDetailedModel(idOf({ category: "SALES" }), sale({ amounts: { ...zeroAmounts, turivaRefundAmount: "1.00" } }), P, NONE);
        expect(t.ok ? null : t.field).toBe("turivaRefundAmount");
    });

    it("cambios: sólo nombres de campo; mismo contenido en otro orden de líneas -> sin cambios", () => {
        const input = parse();
        const r = buildDetailedModel(idOf(), input, P, NONE);
        if (!r.ok) throw new Error(r.error);
        const before = {
            voucherDate: new Date("2027-10-03T00:00:00.000Z"), counterpartyName: "PROVEEDOR SINTETICO SRL", counterpartyVatConditionCode: null, operationCode: null,
            reportedComputableVatCreditAmount: D("315.00"),
            amounts: Object.fromEntries(Object.entries({ ...zeroAmounts, otherTaxesAmount: "30.00", exemptAmount: "45.00" }).map(([k, v]) => [k, D(v)])) as never,
            vatLines: [...r.model.vatLines].reverse().map((l) => ({ ...l, creditAllocation: l.creditAllocation as string })),
        };
        expect(detailedChangedFields(before, input, r.model)).toEqual([]);
        expect(detailedChangedFields({ ...before, counterpartyName: "OTRO" }, input, r.model)).toEqual(["counterpartyName"]);
    });
});

describe("editabilidad detallada", () => {
    const row = { category: "PURCHASES", source: "IMPORT", voucherCode: 1, voucherDate: new Date(), counterpartyDocType: 80, counterpartyDocNumber: "30711111111", taxedNetAmount: D("1"), netWithoutVatBreakdownAmount: D("0") };
    it("sólo importados con el modelo completo", () => {
        expect(detailedEditability(row).ok).toBe(true);
        expect(detailedEditability({ ...row, source: "MANUAL" }).ok).toBe(false);
        expect(detailedEditability({ ...row, voucherCode: null }).ok).toBe(false);
        expect(detailedEditability({ ...row, counterpartyDocNumber: null }).ok).toBe(false);
    });
});
