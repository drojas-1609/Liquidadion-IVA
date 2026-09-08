import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { generateLiquidationExcel, toXlsxNumber } from "@/lib/excel";

const sampleData = {
  period: "01/2026",
  client: "X SA",
  cuit: "30-1",
  sales: { net: "150000.00", vat: "26250.00", total: "176250.00" },
  purchases: { net: "80000.00", vat: "16800.00", total: "96800.00" },
  iva: { debit: "26250.00", credit: "16800.00", balance: "9450.00", retentions: "1234.56", payable: "8215.44" },
  iibb: { rate: "3.523456", base: "150000.00", tax: "5285.18", retentions: "750.00", payable: "4535.18" },
};

describe("lib/excel", () => {
  it("caso 15: las celdas monetarias del XLSX quedan tipadas como número", () => {
    const buf = generateLiquidationExcel(sampleData);
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets["Liquidacion"];

    // "Débito Fiscal (Ventas)" está en la fila 8 (index 7) -> celda B8
    const b8 = ws["B8"];
    expect(b8.t).toBe("n"); // numérica, no string
    expect(b8.v).toBe(26250);

    // "Base Imponible (Ventas Netas)" -> B16
    const b16 = ws["B16"];
    expect(b16.t).toBe("n");
    expect(b16.v).toBe(150000);
  });

  it("caso 16: conversión XLSX fuera del rango seguro FALLA explícitamente (no trunca)", () => {
    // |v| * 100 exactamente = Number.MAX_SAFE_INTEGER (9007199254740991) -> OK
    expect(() => toXlsxNumber("90071992547409.91")).not.toThrow();
    expect(toXlsxNumber("90071992547409.91")).toBe(90071992547409.91);

    // un centavo más -> |v|*100 = 9007199254740992 > MAX_SAFE -> lanza
    expect(() => toXlsxNumber("90071992547409.92")).toThrow(/rango seguro/i);
    expect(() => toXlsxNumber("999999999999999999.99")).toThrow(/rango seguro/i);

    // valor no numérico -> lanza, no devuelve NaN
    expect(() => toXlsxNumber("abc")).toThrow();
  });

  it("caso 16b: generateLiquidationExcel propaga el fallo si un importe excede el rango", () => {
    expect(() =>
      generateLiquidationExcel({ ...sampleData, iva: { ...sampleData.iva, payable: "1000000000000000000.00" } }),
    ).toThrow(/rango seguro/i);
  });
});
