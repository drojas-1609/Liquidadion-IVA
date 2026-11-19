import { describe, it, expect } from "vitest";
import { activeHref, buildClientMenu, parseRoute, periodHref } from "@/lib/navigation/menu";

describe("menú lateral por módulos", () => {
  it("lee cliente, período y pantalla desde la ruta", () => {
    expect(parseRoute("/client/c1/period/p1/liquidation")).toEqual({ clientId: "c1", periodId: "p1", periodPage: "liquidation" });
    expect(parseRoute("/client/c1/period/p1")).toEqual({ clientId: "c1", periodId: "p1", periodPage: null });
    expect(parseRoute("/client/c1/period/new")).toEqual({ clientId: "c1", periodId: null, periodPage: null });
    expect(parseRoute("/client/c1/journal")).toEqual({ clientId: "c1", periodId: null, periodPage: null });
    expect(parseRoute("/clients")).toEqual({ clientId: null, periodId: null, periodPage: null });
  });

  it("el selector de período conserva la pantalla sólo si es de período", () => {
    expect(periodHref("c1", "p2", "sales")).toBe("/client/c1/period/p2/sales");
    expect(periodHref("c1", "p2", "purchases")).toBe("/client/c1/period/p2/purchases");
    expect(periodHref("c1", "p2", null)).toBe("/client/c1/period/p2");
    expect(periodHref("c1", "p2", "otra")).toBe("/client/c1/period/p2");
  });

  it("arma Impuestos, Contabilidad, Sueldos y Respaldos; sin IVA no hay Impuestos", () => {
    const withIva = buildClientMenu({ clientId: "c1", periodId: "p1", hasIva: true }).map((g) => g.key);
    expect(withIva).toEqual(["resumen", "impuestos", "contabilidad", "sueldos", "respaldos", "cliente"]);
    const noIva = buildClientMenu({ clientId: "c1", periodId: "p1", hasIva: false }).map((g) => g.key);
    expect(noIva).not.toContain("impuestos");
  });

  it("sin períodos ofrece crearlo; los estados contables se anuncian sin enlace", () => {
    const g = buildClientMenu({ clientId: "c1", periodId: null, hasIva: true });
    expect(g.find((x) => x.key === "impuestos")!.items).toEqual([{ label: "Crear el primer período", href: "/client/c1/period/new" }]);
    const ec = g.find((x) => x.key === "contabilidad")!.items.find((i) => i.label === "Estados contables")!;
    expect(ec.href).toBeUndefined();
    expect(ec.hint).toContain("Estado de situación patrimonial");
  });

  it("marca el ítem más específico", () => {
    const g = buildClientMenu({ clientId: "c1", periodId: "p1", hasIva: true });
    expect(activeHref("/client/c1/period/p1/sales/new", g)).toBe("/client/c1/period/p1/sales");
    expect(activeHref("/client/c1/period/p1", g)).toBe("/client/c1/period/p1");
    expect(activeHref("/client/c1/journal", g)).toBe("/client/c1/journal");
    expect(activeHref("/settings", g)).toBeNull();
  });
});
