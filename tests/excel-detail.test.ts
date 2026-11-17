import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import * as XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import { computeLiquidation } from "@/lib/liquidation-calc";
import { serializeLiquidation } from "@/lib/serializers";
import { generateLiquidationExcel } from "@/lib/excel";

// Datos sintéticos: CUIT y nombres inventados.
const D = (v: string) => new Prisma.Decimal(v);
const base = {
    type: null, numberTo: null, entityName: null, entityCuit: null, vatRate: null,
    counterpartyDocType: 80, operationCode: null, purchaseAccount: null, netWithoutVatBreakdownAmount: D("0"),
    nonTaxedAmount: D("0"), exemptAmount: D("0"), vatPerceptionAmount: D("0"), nationalPerceptionAmount: D("0"),
    iibbPerceptionAmount: D("0"), municipalPerceptionAmount: D("0"), internalTaxesAmount: D("0"), otherTaxesAmount: D("0"),
    turivaRefundAmount: null, source: "ARCA_SYNC",
};
const sale = (number: number, voucherCode: number, net: string, vat: string, total: string) => ({
    ...base, category: "SALES", date: new Date("2027-10-05T00:00:00Z"), voucherDate: new Date("2027-10-05T00:00:00Z"),
    pointOfSale: 3, number, voucherCode, counterpartyDocNumber: "30111111118", counterpartyName: "CLIENTE SINTETICO SA",
    netAmount: D(net), vatAmount: D(vat), totalAmount: D(total), taxedNetAmount: D(net), totalVatAmount: D(vat),
    voucherTotalAmount: D(total), grossIncomeTaxBaseAmount: D(net), directComputableVatCreditAmount: D("0"),
    reportedComputableVatCreditAmount: null, vatLines: [{ vatRateCode: 5, netAmount: D(net), vatAmount: D(vat), creditAllocation: "NOT_APPLICABLE", computableVatAmount: null }],
});
const purchase = {
    ...base, category: "PURCHASES", date: new Date("2027-10-07T00:00:00Z"), voucherDate: new Date("2027-10-07T00:00:00Z"),
    pointOfSale: 10, number: 555, voucherCode: 81, counterpartyDocNumber: "30222222223", counterpartyName: "PROVEEDOR SINTETICO SRL",
    netAmount: D("1000.00"), vatAmount: D("210.00"), totalAmount: D("1306.00"), taxedNetAmount: D("1000.00"), totalVatAmount: D("210.00"),
    internalTaxesAmount: D("96.00"), voucherTotalAmount: D("1306.00"), workNote: "Nota sintética: descuento incluido en el neto", grossIncomeTaxBaseAmount: D("0"), directComputableVatCreditAmount: D("210.00"),
    reportedComputableVatCreditAmount: null, vatLines: [{ vatRateCode: 5, netAmount: D("1000.00"), vatAmount: D("210.00"), creditAllocation: "DIRECT_COMPUTABLE", computableVatAmount: D("210.00") }],
};
const taxRecords = [
    { date: new Date("2027-10-10T00:00:00Z"), type: "RETENCION IVA", amount: D("50.00"), description: "cert sintético", nature: "RETENTION", agentCuit: "30333333338", regimeCode: 830, certificateNumber: "0001" },
    { date: new Date("2027-10-11T00:00:00Z"), type: "PERCEPCION IVA", amount: D("30.00"), description: null, nature: "PERCEPTION", agentCuit: "30444444443" },
    { date: new Date("2027-10-12T00:00:00Z"), type: "PERCEPCION IIBB", amount: D("12.00"), description: null },
    { date: new Date("2027-10-13T00:00:00Z"), type: "SIRCREB", amount: D("8.00"), description: null },
];
const period = {
    invoices: [sale(1, 1, "1000.00", "210.00", "1210.00"), sale(2, 3, "100.00", "21.00", "121.00"), purchase],
    taxRecords, client: { defaultIibbRate: D("3") }, vatSettings: null, vatCreditAdjustments: [],
};

function build() {
    const dto = serializeLiquidation(computeLiquidation(period as never));
    const buf = generateLiquidationExcel({ ...dto, period: "10/2027", client: "SINTETICA SA", cuit: "30-55555555-5", detail: { invoices: period.invoices as never, taxRecords: taxRecords as never } });
    return XLSX.read(buf, { type: "buffer", cellFormula: true });
}

describe("exportación: hojas de detalle para el control cruzado", () => {
    it("agrega Ventas, Compras, Retenciones, Percepciones y Control después de la liquidación", () => {
        expect(build().SheetNames).toEqual(["Liquidacion", "Ventas", "Compras", "Retenciones", "Percepciones", "Control"]);
    });

    it("una fila por comprobante, la nota de crédito resta y el total tiene fórmula SUM", () => {
        const ws = build().Sheets["Ventas"];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { range: 3 });
        expect(rows).toHaveLength(3); // 2 comprobantes + TOTAL
        expect(rows[0]).toMatchObject({ Número: 1, "Neto 21 %": 1000, "IVA 21 %": 210, Total: 1210, "Base IIBB": 1000 });
        expect(rows[1]).toMatchObject({ Número: 2, "IVA 21 %": -21, Total: -121 });
        const total = Object.values(ws).find((c) => (c as XLSX.CellObject).f?.startsWith("SUM(") && (c as XLSX.CellObject).v === 1089) as XLSX.CellObject;
        expect(total).toBeDefined();
    });

    it("compras discrimina impuestos internos y el crédito directo computable", () => {
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(build().Sheets["Compras"], { range: 3 });
        expect(rows[0]).toMatchObject({ Tipo: 81, "Impuestos internos": 96, "IVA total": 210, Total: 1306, "Crédito fiscal directo computable": 210 });
    });

    it("retenciones y percepciones se separan con el impuesto de la liquidación", () => {
        const wb = build();
        const ret = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Retenciones"], { range: 3 });
        const per = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets["Percepciones"], { range: 3 });
        expect(ret.slice(0, -1).map((r) => [r.Impuesto, r.Tipo, r.Importe])).toEqual([["IVA", "RETENCION IVA", 50], ["IIBB", "SIRCREB", 8]]);
        expect(per.slice(0, -1).map((r) => [r.Impuesto, r.Tipo, r.Importe])).toEqual([["IVA", "PERCEPCION IVA", 30], ["IIBB", "PERCEPCION IIBB", 12]]);
    });

    it("la hoja Control da diferencia 0 en todos los conceptos y usa fórmulas", () => {
        const ws = build().Sheets["Control"];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { range: 3 });
        expect(rows.map((r) => r.Concepto)).toEqual([
            "Débito fiscal (IVA de ventas)", "Crédito fiscal directo computable de compras", "Total de ventas", "Total de compras",
            "Base imponible IIBB", "Retenciones de IVA", "Percepciones de IVA (incluye aduaneras)", "Retenciones, percepciones y recaudaciones de IIBB",
        ]);
        expect(rows.map((r) => r.Diferencia)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        expect(rows.map((r) => r["Según detalle"])).toEqual([189, 210, 1089, 1306, 900, 50, 30, 20]);
        expect(ws["B5"].f).toBe("Liquidacion!B8");
        expect(ws["C5"].f).toMatch(/^Ventas!/);
        expect(ws["D5"].f).toBe("C5-B5");
    });

    it("sin detalle conserva la exportación anterior (una sola hoja)", () => {
        const dto = serializeLiquidation(computeLiquidation(period as never));
        const wb = XLSX.read(generateLiquidationExcel({ ...dto, period: "10/2027", client: "X", cuit: "30-55555555-5" }), { type: "buffer" });
        expect(wb.SheetNames).toEqual(["Liquidacion"]);
    });
    it("la nota del papel de trabajo sale en «Observaciones» de cada comprobante", () => {
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(build().Sheets["Compras"], { range: 3 });
        expect(rows[0]).toMatchObject({ Observaciones: "Nota sintética: descuento incluido en el neto" });
        const ventas = XLSX.utils.sheet_to_json<Record<string, unknown>>(build().Sheets["Ventas"], { range: 3 });
        expect(ventas[0].Observaciones ?? "").toBe("");
    });
});
