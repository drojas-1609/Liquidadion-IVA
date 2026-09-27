import { describe, it, expect } from "vitest";
import {
  VOUCHER_MATRIX,
  TURIVA_MATRIX,
  allowedVoucherCodes,
  allowedVoucherVariants,
  checkVoucherCombination,
  type VoucherCheckInput,
} from "@/lib/arca/voucher-matrix";

const A = [1, 2, 3];
const B = [6, 7, 8];
const C = [11, 12, 13];
const E = [19, 20, 21];
const M = [51, 52, 53];
const T = [195, 196, 197];

const input = (over: Partial<VoucherCheckInput>): VoucherCheckInput => ({
  direction: "SALES",
  clientCondition: 1,
  counterpartyCondition: 1,
  voucherCode: 1,
  dateIso: "2026-05-10",
  voucherVariant: "NONE",
  turivaRelationCode: null,
  counterpartyDocType: 80,
  ...over,
});

describe("VOUCHER_MATRIX — integridad", () => {
  it("ids únicos, fuentes en filas ALLOWED y ningún 063 ni leyenda de retención almacenable", () => {
    const ids = VOUCHER_MATRIX.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of VOUCHER_MATRIX) {
      expect(r.codes, r.id).not.toContain(63);
      if (r.status === "ALLOWED") expect(r.sources.length, r.id).toBeGreaterThan(0);
      if (r.status === "PENDING") expect(r.variants, r.id).toEqual([]);
    }
    expect(JSON.stringify(VOUCHER_MATRIX.map((r) => r.variants))).not.toMatch(/OPERACION_SUJETA_A_RETENCION/);
  });

  it("filas pendientes documentadas: V4, V14, C4, C14 (retención 2019–2025), V24, V25, C27 (emisor 15), C28", () => {
    expect(VOUCHER_MATRIX.filter((r) => r.status === "PENDING").map((r) => r.id).sort()).toEqual(
      ["C14", "C27", "C28", "C4", "V14", "V24", "V25", "V4"].sort(),
    );
  });
});

describe("ventas — selector (sólo filas ALLOWED)", () => {
  it("RI → RI: A, 051–053 y T (TurIVA 0002/0006); sin B", () => {
    expect(allowedVoucherCodes("SALES", 1, 1, "2026-05-10")).toEqual([...A, ...M, ...T]);
  });

  it("RI → Monotributo (6, 13, 16): B hasta 30/06/2021; A desde 01/07/2021", () => {
    for (const rs of [6, 13, 16]) {
      expect(allowedVoucherCodes("SALES", 1, rs, "2021-06-30"), String(rs)).toEqual(B);
      expect(allowedVoucherCodes("SALES", 1, rs, "2021-07-01"), String(rs)).toEqual([...A, ...M]);
    }
  });

  it("051–053 a monotributistas antes del 01/07/2021 no se ofrecen", () => {
    expect(allowedVoucherCodes("SALES", 1, 6, "2020-01-01")).not.toContain(51);
  });

  it("RI → 4, 7, 15: B; RI → 5: B y T (TurIVA 0001/0003/0004/0005)", () => {
    for (const r of [4, 7, 15]) expect(allowedVoucherCodes("SALES", 1, r, "2026-05-10"), String(r)).toEqual(B);
    expect(allowedVoucherCodes("SALES", 1, 5, "2026-05-10")).toEqual([...B, ...T]);
  });

  it("RI, Exento o Monotributo → Cliente del Exterior (9): E (RI además T desde 01/04/2017)", () => {
    expect(allowedVoucherCodes("SALES", 1, 9, "2026-05-10")).toEqual([...E, ...T]);
    expect(allowedVoucherCodes("SALES", 4, 9, "2026-05-10")).toEqual(E);
    expect(allowedVoucherCodes("SALES", 6, 9, "2026-05-10")).toEqual(E);
  });

  it("Exento o Monotributo → 1, 4, 5, 6, 7, 13, 15, 16: C", () => {
    for (const issuer of [4, 6]) for (const r of [1, 4, 5, 6, 7, 13, 15, 16]) {
      expect(allowedVoucherCodes("SALES", issuer, r, "2026-05-10"), `${issuer}->${r}`).toEqual(C);
    }
  });

  it("receptores 8 y 10: nada habilitado (pendiente)", () => {
    for (const issuer of [1, 4, 6]) for (const r of [8, 10]) expect(allowedVoucherCodes("SALES", issuer, r, "2026-05-10")).toEqual([]);
  });

  it("condición del cliente desconocida o contraparte sin condición: nada habilitado", () => {
    expect(allowedVoucherCodes("SALES", null, 1, "2026-05-10")).toEqual([]);
    expect(allowedVoucherCodes("SALES", 1, null, "2026-05-10")).toEqual([]);
  });
});

describe("compras — selector", () => {
  it("emisor RI → cliente RI: A y 051–053", () => {
    expect(allowedVoucherCodes("PURCHASES", 1, 1, "2026-05-10")).toEqual([...A, ...M, ...T]);
  });

  it("emisor RI → cliente Monotributo: B hasta 30/06/2021; A desde 01/07/2021", () => {
    expect(allowedVoucherCodes("PURCHASES", 6, 1, "2021-06-30")).toEqual(B);
    expect(allowedVoucherCodes("PURCHASES", 6, 1, "2021-07-01")).toEqual([...A, ...M]);
  });

  it("emisor RI → cliente Exento: B", () => {
    expect(allowedVoucherCodes("PURCHASES", 4, 1, "2026-05-10")).toEqual(B);
  });

  it("emisores 4, 6, 13, 16 → clientes 1, 4, 6: C", () => {
    for (const issuer of [4, 6, 13, 16]) for (const client of [1, 4, 6]) {
      expect(allowedVoucherCodes("PURCHASES", client, issuer, "2026-05-10"), `${issuer}->${client}`).toEqual(C);
    }
  });

  it("emisor 15 (IVA No Alcanzado), 8 y 10: nada habilitado", () => {
    for (const issuer of [15, 8, 10]) expect(allowedVoucherCodes("PURCHASES", 1, issuer, "2026-05-10"), String(issuer)).toEqual([]);
  });
});

describe("variantes de 001–003 por fecha", () => {
  it("20/10/2003–10/11/2019: NONE y PAGO_EN_CBU_INFORMADA", () => {
    expect(allowedVoucherVariants("SALES", 1, 1, 1, "2003-10-20").sort()).toEqual(["NONE", "PAGO_EN_CBU_INFORMADA"]);
    expect(allowedVoucherVariants("SALES", 1, 1, 1, "2019-11-10").sort()).toEqual(["NONE", "PAGO_EN_CBU_INFORMADA"]);
  });

  it("antes del 20/10/2003: sólo NONE", () => {
    expect(allowedVoucherVariants("SALES", 1, 1, 1, "2003-10-19")).toEqual(["NONE"]);
  });

  it("11/11/2019–30/11/2025: sólo NONE (la leyenda de retención queda pendiente)", () => {
    expect(allowedVoucherVariants("SALES", 1, 1, 2, "2019-11-11")).toEqual(["NONE"]);
    expect(allowedVoucherVariants("PURCHASES", 1, 1, 3, "2025-11-30")).toEqual(["NONE"]);
  });

  it("desde 01/12/2025: NONE y PAGO_EN_CBU_INFORMADA, también a monotributistas", () => {
    expect(allowedVoucherVariants("SALES", 1, 1, 1, "2025-12-01").sort()).toEqual(["NONE", "PAGO_EN_CBU_INFORMADA"]);
    expect(allowedVoucherVariants("SALES", 1, 6, 1, "2025-12-01").sort()).toEqual(["NONE", "PAGO_EN_CBU_INFORMADA"]);
  });

  it("códigos que no son 001–003: sin variantes", () => {
    for (const code of [51, 6, 11, 19, 195]) expect(allowedVoucherVariants("SALES", 1, 1, code, "2026-05-10")).toEqual([]);
  });
});

describe("checkVoucherCombination", () => {
  it("combinación admitida devuelve la fila", () => {
    expect(checkVoucherCombination(input({}))).toMatchObject({ ok: true, rowId: "V1", partialValidation: false });
    expect(checkVoucherCombination(input({ voucherCode: 51, voucherVariant: null }))).toMatchObject({ ok: true, rowId: "V9" });
    expect(checkVoucherCombination(input({ direction: "PURCHASES", clientCondition: 6, counterpartyCondition: 1, voucherCode: 6, voucherVariant: null, dateIso: "2021-06-30" }))).toMatchObject({ ok: true, rowId: "C11" });
  });

  it("001–003 exigen variante; otros códigos la rechazan", () => {
    expect(checkVoucherCombination(input({ voucherVariant: null }))).toMatchObject({ ok: false, field: "voucherVariant" });
    expect(checkVoucherCombination(input({ voucherCode: 51, voucherVariant: "NONE" }))).toMatchObject({ ok: false, field: "voucherVariant" });
  });

  it("PAGO_EN_CBU_INFORMADA entre 11/11/2019 y 30/11/2025 -> rechazada", () => {
    expect(checkVoucherCombination(input({ voucherVariant: "PAGO_EN_CBU_INFORMADA", dateIso: "2020-01-01" }))).toMatchObject({ ok: false, field: "voucherVariant" });
    expect(checkVoucherCombination(input({ voucherVariant: "PAGO_EN_CBU_INFORMADA", dateIso: "2025-12-01" }))).toMatchObject({ ok: true, rowId: "V5" });
  });

  it("combinación pendiente (emisor 15) -> rechazada como pendiente", () => {
    const r = checkVoucherCombination(input({ direction: "PURCHASES", clientCondition: 1, counterpartyCondition: 15, voucherCode: 11, voucherVariant: null }));
    expect(r).toMatchObject({ ok: false, field: "voucherCode", pending: true });
  });

  it("combinación no admitida (RI → RI con B) -> rechazada", () => {
    expect(checkVoucherCombination(input({ voucherCode: 6, voucherVariant: null }))).toMatchObject({ ok: false, field: "voucherCode", pending: false });
  });

  it("cliente con condición fuera de las tres, o contraparte sin condición -> rechazada", () => {
    expect(checkVoucherCombination(input({ clientCondition: null }))).toMatchObject({ ok: false, field: "clientCondition" });
    expect(checkVoucherCombination(input({ counterpartyCondition: null }))).toMatchObject({ ok: false, field: "counterpartyVatConditionCode" });
  });

  it("relación TurIVA en un código no T -> rechazada", () => {
    expect(checkVoucherCombination(input({ turivaRelationCode: "0002" }))).toMatchObject({ ok: false, field: "turivaRelationCode" });
  });
});

describe("TurIVA (research-report.md §3.3 y §3.4)", () => {
  const t = (over: Partial<VoucherCheckInput>) =>
    checkVoucherCombination(input({ voucherCode: 195, voucherVariant: null, dateIso: "2026-05-10", ...over }));

  it("matriz TurIVA exacta", () => {
    expect(TURIVA_MATRIX.map((r) => [r.id, r.direction, r.receivers, r.relations])).toEqual([
      ["TV1", "SALES", [1], ["0002", "0006"]],
      ["TV2", "SALES", [5, 9], ["0001", "0005"]],
      ["TV3", "SALES", [5, 9], ["0003", "0004"]],
      ["TC1", "PURCHASES", [1], ["0002", "0006"]],
    ]);
  });

  it("ventas: receptor 1 con 0002/0006 y CUIT; validación parcial y sección TURIVA", () => {
    for (const rel of ["0002", "0006"]) {
      expect(t({ turivaRelationCode: rel })).toEqual({ ok: true, rowId: "TV1", partialValidation: true, requiresTurivaSection: true });
    }
  });

  it("ventas: receptor 5 o 9 con 0001/0005 y 0003/0004", () => {
    expect(t({ counterpartyCondition: 5, turivaRelationCode: "0001", counterpartyDocType: 94 })).toMatchObject({ ok: true, rowId: "TV2" });
    expect(t({ counterpartyCondition: 9, turivaRelationCode: "0005", counterpartyDocType: 91 })).toMatchObject({ ok: true, rowId: "TV2" });
    expect(t({ counterpartyCondition: 9, turivaRelationCode: "0004", counterpartyDocType: 80 })).toMatchObject({ ok: true, rowId: "TV3" });
  });

  it("relación incompatible con el receptor -> rechazada", () => {
    expect(t({ counterpartyCondition: 1, turivaRelationCode: "0001" })).toMatchObject({ ok: false, field: "turivaRelationCode" });
    expect(t({ counterpartyCondition: 5, turivaRelationCode: "0002", counterpartyDocType: 94 })).toMatchObject({ ok: false, field: "turivaRelationCode" });
  });

  it("relación ausente, inválida o sin ceros -> rechazada", () => {
    expect(t({ turivaRelationCode: null })).toMatchObject({ ok: false, field: "turivaRelationCode" });
    expect(t({ turivaRelationCode: "0007" })).toMatchObject({ ok: false, field: "turivaRelationCode" });
    expect(t({ turivaRelationCode: "2" })).toMatchObject({ ok: false, field: "turivaRelationCode" });
  });

  it("documento del receptor: 80/91/94/96; RI con CUIT; consumidor final sin CUIT", () => {
    expect(t({ turivaRelationCode: "0002", counterpartyDocType: 96 })).toMatchObject({ ok: false, field: "counterpartyDocType" });
    expect(t({ counterpartyCondition: 5, turivaRelationCode: "0001", counterpartyDocType: 80 })).toMatchObject({ ok: false, field: "counterpartyDocType" });
    expect(t({ counterpartyCondition: 9, turivaRelationCode: "0001", counterpartyDocType: 86 })).toMatchObject({ ok: false, field: "counterpartyDocType" });
  });

  it("antes del 01/04/2017 -> rechazada", () => {
    expect(t({ turivaRelationCode: "0002", dateIso: "2017-03-31" })).toMatchObject({ ok: false, field: "date" });
    expect(t({ turivaRelationCode: "0002", dateIso: "2017-04-01" })).toMatchObject({ ok: true });
  });

  it("emisor que no es RI -> rechazada", () => {
    expect(t({ clientCondition: 6, turivaRelationCode: "0002" })).toMatchObject({ ok: false, field: "turivaRelationCode" });
  });

  it("compras: sólo emisor RI y cliente RI con 0002/0006", () => {
    const p = (over: Partial<VoucherCheckInput>) => t({ direction: "PURCHASES", ...over });
    expect(p({ turivaRelationCode: "0006" })).toMatchObject({ ok: true, rowId: "TC1" });
    expect(p({ turivaRelationCode: "0001" })).toMatchObject({ ok: false, field: "turivaRelationCode" });
    expect(p({ clientCondition: 6, turivaRelationCode: "0002" })).toMatchObject({ ok: false, field: "turivaRelationCode" });
  });

  it("selector: T sólo desde 01/04/2017 y sólo para pares TurIVA", () => {
    expect(allowedVoucherCodes("SALES", 1, 5, "2017-03-31")).not.toContain(195);
    expect(allowedVoucherCodes("SALES", 1, 5, "2017-04-01")).toEqual([...B, ...T]);
    expect(allowedVoucherCodes("SALES", 6, 5, "2026-05-10")).not.toContain(195);
  });
});
