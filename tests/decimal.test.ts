import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { sum, roundMoney, computeVatAmount, computeTotalAmount } from "@/lib/decimal";

const D = (v: string | number) => new Prisma.Decimal(v);

describe("lib/decimal", () => {
  it("caso 1: 0.1 + 0.2 === 0.3 con Decimal (sin deriva binaria)", () => {
    expect(sum(["0.1", "0.2"]).equals("0.3")).toBe(true);
    // sanidad: el mismo cálculo con number nativo NO da 0.3
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("caso 2: IVA 21% de 1000 = 210.00", () => {
    expect(computeVatAmount("1000", "21").toFixed(2)).toBe("210.00");
  });

  it("caso 3: IVA 10,5% de 1000 = 105.00", () => {
    expect(computeVatAmount("1000", "10.5").toFixed(2)).toBe("105.00");
  });

  it("caso 4: IVA 2,5% de 1000 = 25.00", () => {
    expect(computeVatAmount("1000", "2.5").toFixed(2)).toBe("25.00");
  });

  it("caso 6: importe negativo (nota de crédito) net -1000 + vat -210 = -1210.00", () => {
    const net = D("-1000");
    const vat = computeVatAmount(net, "21");
    expect(vat.toFixed(2)).toBe("-210.00");
    expect(computeTotalAmount(net, vat).toFixed(2)).toBe("-1210.00");
  });

  it("caso 7: montos grandes dentro del rango admitido (NUMERIC(18,2))", () => {
    // Muy por encima del rango seguro de JS number, pero dentro de NUMERIC(18,2).
    const net = D("1000000000000.00"); // 13 dígitos enteros
    const vat = computeVatAmount(net, "21");
    expect(vat.toFixed(2)).toBe("210000000000.00");
    expect(computeTotalAmount(net, vat).toFixed(2)).toBe("1210000000000.00");
    // Precisión exacta al centavo con un valor fuera del rango seguro de JS.
    const big = D("92233720368547.75");
    expect(big.plus("0.01").toFixed(2)).toBe("92233720368547.76");
    expect(big.times(3).toFixed(2)).toBe("276701161105643.25");
  });

  it("caso 8: medio centavo con ROUND_HALF_UP", () => {
    expect(roundMoney("2.345").toFixed(2)).toBe("2.35"); // .5 -> arriba
    expect(roundMoney("2.355").toFixed(2)).toBe("2.36");
    // IVA que cae justo en medio centavo: 0.10 * 5% = 0.005 -> 0.01
    expect(computeVatAmount("0.10", "5").toFixed(2)).toBe("0.01");
  });

  it("caso 9: valores límite .005 y .995 (incluye negativos, away-from-zero)", () => {
    expect(roundMoney("1.005").toFixed(2)).toBe("1.01");
    expect(roundMoney("1.995").toFixed(2)).toBe("2.00");
    expect(roundMoney("-1.005").toFixed(2)).toBe("-1.01");
    expect(roundMoney("-1.995").toFixed(2)).toBe("-2.00");
  });

  it("caso 14: suma de >500 comprobantes sin deriva, contra referencia independiente", () => {
    const count = 1000;
    const cents = "0.01";
    const values = Array.from({ length: count }, () => cents);

    const withDecimal = sum(values);

    // Referencia independiente: aritmética de enteros sobre centavos.
    const refCents = count * 1; // 1 centavo por comprobante
    const ref = `${Math.floor(refCents / 100)}.${String(refCents % 100).padStart(2, "0")}`;

    expect(withDecimal.toFixed(2)).toBe(ref); // "10.00"
    expect(withDecimal.equals("10")).toBe(true);
    // el acumulado nativo derivaría:
    const nativeAcc = values.reduce((a, v) => a + Number(v), 0);
    expect(nativeAcc).not.toBe(10);
  });

  it("caso extra: sum() no redondea intermedios (3 decimales sobreviven la sumatoria)", () => {
    expect(sum(["0.001", "0.001", "0.001"]).toString()).toBe("0.003");
  });
});
