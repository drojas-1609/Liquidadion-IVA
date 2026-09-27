import { describe, it, expect } from "vitest";
import { CLIENT_CONDITIONS, clientConditionCode, isClientCondition } from "@/lib/client-condition";
import { VAT_CONDITIONS } from "@/lib/arca/catalogs";

describe("lib/client-condition", () => {
  it("sólo las tres etiquetas de las pantallas de clientes", () => {
    expect(CLIENT_CONDITIONS).toEqual(["Responsable Inscripto", "Monotributo", "Exento"]);
  });

  it("cada etiqueta corresponde a un código oficial de Tipos de responsables", () => {
    expect(clientConditionCode("Responsable Inscripto")).toBe(1);
    expect(clientConditionCode("Monotributo")).toBe(6);
    expect(clientConditionCode("Exento")).toBe(4);
    const official = new Set(VAT_CONDITIONS.map((c) => c.code));
    for (const c of CLIENT_CONDITIONS) expect(official.has(clientConditionCode(c) as number), c).toBe(true);
  });

  it("texto fuera de las tres etiquetas -> null (la matriz no habilita comprobantes)", () => {
    for (const v of ["RI", "responsable inscripto", " Monotributo", "Consumidor Final", "", null, undefined, 1]) {
      expect(isClientCondition(v), String(v)).toBe(false);
      expect(clientConditionCode(v), String(v)).toBeNull();
    }
  });
});
