import { describe, it, expect } from "vitest";
import {
  EXPECTED_UPDATED_AT_ERROR,
  TAX_DESCRIPTION_MAX,
  TAX_PERIOD_IMMUTABLE_MESSAGE,
  buildTaxInput,
  buildTaxUpdateInput,
  isDateInPeriod,
  parseIsoDateOnly,
  type InputResult,
} from "@/lib/api-input";
import { TAX_RECORD_TYPES } from "@/lib/tax-types";

const MAX = "9999999999999999.99";
const OVER = "10000000000000000.00";
const TOKEN = "2026-05-10T12:34:56.789Z";

const create = { date: "2026-05-10", type: "RETENCION IVA", amount: "2500.00", periodId: "p1" };
const update = { date: "2026-05-10", type: "RETENCION IVA", amount: "2500.00", expectedUpdatedAt: TOKEN };

const buildUpdate = (body: unknown) => buildTaxUpdateInput(body, "p1");

function expectField(r: InputResult<unknown>, field: string, label = ""): void {
  expect(r.ok, label).toBe(false);
  if (!r.ok) {
    expect(r.status, label).toBe(422);
    expect(r.field, label).toBe(field);
  }
}

/** Ambos builders comparten las reglas de fecha, tipo, monto y descripción. */
const BUILDERS = [
  ["buildTaxInput", (patch: Record<string, unknown>) => buildTaxInput({ ...create, ...patch })],
  ["buildTaxUpdateInput", (patch: Record<string, unknown>) => buildUpdate({ ...update, ...patch })],
] as const;

describe("parseIsoDateOnly — fecha calendario estricta en UTC", () => {
  it("AAAA-MM-DD válido -> medianoche UTC del mismo día (incluido 29/02 bisiesto)", () => {
    expect(parseIsoDateOnly("2026-05-10")?.toISOString()).toBe("2026-05-10T00:00:00.000Z");
    expect(parseIsoDateOnly("2024-02-29")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(parseIsoDateOnly("2026-12-31")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it.each([
    ["29/02 no bisiesto", "2026-02-29"],
    ["30 de febrero", "2026-02-30"],
    ["mes 13", "2026-13-01"],
    ["mes 00", "2026-00-10"],
    ["día 00", "2026-05-00"],
    ["31 de abril", "2026-04-31"],
    ["timestamp", "2026-05-10T00:00:00.000Z"],
    ["timestamp sin zona", "2026-05-10T00:00"],
    ["offset", "2026-05-10T00:00:00-03:00"],
    ["offset sin hora", "2026-05-10-03:00"],
    ["barras", "2026/05/10"],
    ["dd/mm/aaaa", "10/05/2026"],
    ["espacio inicial", " 2026-05-10"],
    ["espacio final", "2026-05-10 "],
    ["espacio interno", "2026-05-10 00:00"],
    ["sin ceros", "2026-5-10"],
    ["año expandido", "+002026-05-10"],
    ["texto", "May 10 2026"],
    ["vacío", ""],
  ])("%s (%j) -> null", (_l, v) => {
    expect(parseIsoDateOnly(v)).toBeNull();
  });
});

describe("isDateInPeriod — pertenencia al mes/año del período (UTC)", () => {
  const d = (v: string) => parseIsoDateOnly(v)!;

  it("primer y último día del mes -> dentro", () => {
    expect(isDateInPeriod(d("2026-05-01"), { month: 5, year: 2026 })).toBe(true);
    expect(isDateInPeriod(d("2026-05-31"), { month: 5, year: 2026 })).toBe(true);
    expect(isDateInPeriod(d("2024-02-29"), { month: 2, year: 2024 })).toBe(true);
  });

  it("mes vecino o mismo mes de otro año -> fuera", () => {
    expect(isDateInPeriod(d("2026-04-30"), { month: 5, year: 2026 })).toBe(false);
    expect(isDateInPeriod(d("2026-06-01"), { month: 5, year: 2026 })).toBe(false);
    expect(isDateInPeriod(d("2025-05-10"), { month: 5, year: 2026 })).toBe(false);
  });

  it("cambio de año: diciembre / enero", () => {
    expect(isDateInPeriod(d("2025-12-31"), { month: 12, year: 2025 })).toBe(true);
    expect(isDateInPeriod(d("2026-01-01"), { month: 12, year: 2025 })).toBe(false);
    expect(isDateInPeriod(d("2026-01-01"), { month: 1, year: 2026 })).toBe(true);
    expect(isDateInPeriod(d("2025-12-31"), { month: 1, year: 2026 })).toBe(false);
  });

  it("usa el día UTC, no la zona local: el último milisegundo del mes sigue dentro", () => {
    expect(isDateInPeriod(new Date("2026-05-31T23:59:59.999Z"), { month: 5, year: 2026 })).toBe(true);
    expect(isDateInPeriod(new Date("2026-06-01T00:00:00.000Z"), { month: 5, year: 2026 })).toBe(false);
  });
});

describe.each(BUILDERS)("%s — reglas comunes", (_name, build) => {
  it("los seis tipos del catálogo -> ok, con el valor exacto", () => {
    for (const t of TAX_RECORD_TYPES) {
      const r = build({ type: t.value });
      expect(r.ok, t.value).toBe(true);
      if (r.ok) expect(r.data.type).toBe(t.value);
    }
  });

  it.each([
    ["ausente", undefined],
    ["vacío", ""],
    ["espacios", "   "],
    ["desconocido", "RETENCION GANANCIAS"],
    ["minúsculas", "retencion iva"],
    ["mayúsculas mixtas", "Retencion IVA"],
    ["con acento", "RETENCIÓN IVA"],
    ["con espacios en los extremos", " SIRCREB "],
    ["número", 1],
  ])("tipo %s -> 422 type", (_l, type) => {
    expectField(build({ type }), "type");
  });

  it("fecha: válida y bisiesta -> medianoche UTC", () => {
    for (const date of ["2026-05-10", "2024-02-29"]) {
      const r = build({ date });
      expect(r.ok, date).toBe(true);
      if (r.ok) expect(r.data.date.toISOString()).toBe(`${date}T00:00:00.000Z`);
    }
  });

  it.each([
    ["ausente", undefined],
    ["imposible", "2026-02-30"],
    ["29/02 no bisiesto", "2026-02-29"],
    ["timestamp", "2026-05-10T00:00:00.000Z"],
    ["offset", "2026-05-10T00:00:00-03:00"],
    ["barras", "2026/05/10"],
    ["espacios", " 2026-05-10 "],
    ["número", 20260510],
  ])("fecha %s -> 422 date", (_l, date) => {
    expectField(build({ date }), "date");
  });

  it("la fecha NO se controla contra el período en el builder (se hará bajo el bloqueo)", () => {
    expect(build({ date: "1999-01-01" }).ok).toBe(true);
  });

  it("monto: valor normal, mínimo positivo y máximo de NUMERIC(18,2) -> Decimal exacto", () => {
    for (const [amount, fixed] of [["2500.00", "2500.00"], ["0.01", "0.01"], ["1", "1.00"], [MAX, MAX]]) {
      const r = build({ amount });
      expect(r.ok, amount).toBe(true);
      if (r.ok) expect(r.data.amount.toFixed(2)).toBe(fixed);
    }
  });

  it.each([
    ["0", "0"],
    ["0.00", "0.00"],
    ["-0", "-0"],
    ["-1", "-1"],
    ["0.001", "0.001"],
    ["exceso de escala", "1.005"],
    ["fuera de rango", OVER],
    ["number JSON", 10],
    ["vacío", ""],
    ["ausente", undefined],
    ["separador de miles", "1,000.00"],
    ["exponencial", "1e3"],
  ])("monto %s -> 422 amount", (_l, amount) => {
    expectField(build({ amount }), "amount");
  });

  it("descripción: ausente / null / vacía / sólo espacios -> null; con espacios -> trim", () => {
    const cases: Array<[unknown, string | null]> = [
      [undefined, null],
      [null, null],
      ["", null],
      ["   ", null],
      ["  Banco Galicia  ", "Banco Galicia"],
    ];
    for (const [description, expected] of cases) {
      const r = build({ description });
      expect(r.ok, JSON.stringify(description)).toBe(true);
      if (r.ok) expect(r.data.description).toBe(expected);
    }
  });

  it(`descripción: ${TAX_DESCRIPTION_MAX} caracteres -> ok; ${TAX_DESCRIPTION_MAX + 1} -> 422 (se cuenta tras el trim)`, () => {
    expect(TAX_DESCRIPTION_MAX).toBe(200);
    const ok = build({ description: `  ${"a".repeat(200)}  ` });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.description).toBe("a".repeat(200));
    expect(build({ description: "ñ".repeat(200) }).ok).toBe(true);
    expectField(build({ description: "a".repeat(201) }), "description");
  });

  it.each([
    ["número", 123],
    ["booleano", true],
    ["objeto", { text: "x" }],
    ["arreglo", ["x"]],
  ])("descripción %s -> 422 description", (_l, description) => {
    expectField(build({ description }), "description");
  });

  it("cuerpo que no es un objeto -> 422 body", () => {
    for (const body of [null, "x", 1, []]) {
      expectField(_name === "buildTaxInput" ? buildTaxInput(body) : buildUpdate(body), "body", JSON.stringify(body));
    }
  });
});

describe("buildTaxInput — alta", () => {
  it("datos exactos; ignora organización, cliente, autoría y otras claves", () => {
    const r = buildTaxInput({
      ...create,
      description: " Banco X ",
      organizationId: "org_x",
      clientId: "c_x",
      createdById: "u",
      updatedById: "u",
      id: "t_x",
      updatedAt: TOKEN,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.data).sort()).toEqual(["amount", "date", "description", "periodId", "type"]);
      expect(r.data).toMatchObject({ type: "RETENCION IVA", description: "Banco X", periodId: "p1" });
      expect(r.data.date.toISOString()).toBe("2026-05-10T00:00:00.000Z");
      expect(r.data.amount.toFixed(2)).toBe("2500.00");
    }
  });

  it("periodId ausente o vacío -> 422 periodId", () => {
    expectField(buildTaxInput({ ...create, periodId: undefined }), "periodId");
    expectField(buildTaxInput({ ...create, periodId: "" }), "periodId");
  });
});

describe("buildTaxUpdateInput — edición", () => {
  it("datos exactos con expectedUpdatedAt; sin periodId ni claves ajenas en el resultado", () => {
    const r = buildUpdate({
      ...update,
      type: "SIRTAC",
      organizationId: "org_x",
      clientId: "c_x",
      createdById: "u",
      updatedById: "u",
      id: "t_x",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.data).sort()).toEqual(["amount", "date", "description", "expectedUpdatedAt", "type"]);
      expect(r.data.type).toBe("SIRTAC");
      expect(r.data.description).toBeNull();
      expect(r.data.expectedUpdatedAt.toISOString()).toBe(TOKEN);
    }
  });

  it("periodId ausente o igual al esperado -> ok", () => {
    expect(buildUpdate(update).ok).toBe(true);
    expect(buildUpdate({ ...update, periodId: "p1" }).ok).toBe(true);
  });

  it.each([
    ["distinto", "p2"],
    ["vacío", ""],
    ["null", null],
    ["número", 1],
  ])("periodId %s -> 422 periodId con mensaje de inmutabilidad", (_l, periodId) => {
    const r = buildUpdate({ ...update, periodId });
    expectField(r, "periodId");
    if (!r.ok) expect(r.error).toBe(TAX_PERIOD_IMMUTABLE_MESSAGE);
  });

  it.each([
    ["ausente", undefined],
    ["null", null],
    ["sin milisegundos", "2026-05-10T12:34:56Z"],
    ["con offset", "2026-05-10T12:34:56.789-03:00"],
    ["sólo fecha", "2026-05-10"],
    ["inexistente", "2026-02-30T00:00:00.000Z"],
    ["número", 1715344496789],
  ])("expectedUpdatedAt %s -> 422 expectedUpdatedAt", (_l, expectedUpdatedAt) => {
    const r = buildUpdate({ ...update, expectedUpdatedAt });
    expectField(r, "expectedUpdatedAt");
    if (!r.ok) expect(r.error).toBe(EXPECTED_UPDATED_AT_ERROR);
  });
});
