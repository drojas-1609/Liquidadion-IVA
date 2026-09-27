import { describe, it, expect } from "vitest";
import {
  DOCUMENT_RULES,
  DOC_TYPE_SIN_IDENTIFICAR,
  allowedDocTypes,
  allowedDocumentRule,
  pendingDocumentRules,
  checkCounterpartyDocument,
  type CounterpartyDocumentInput,
} from "@/lib/arca/document-rules";
import { DOCUMENT_TYPES, VAT_CONDITIONS, VOUCHER_TYPES } from "@/lib/arca/catalogs";
import { VOUCHER_MATRIX, checkVoucherCombination } from "@/lib/arca/voucher-matrix";

const VALID_CUIT = "30999999995";
const VALID_CUIL = "20123456786";
const NUMBER_FOR: Record<number, string> = {
  80: VALID_CUIT,
  86: VALID_CUIL,
  91: "AB12345",
  94: "P1234567",
  96: "12345678",
  99: "0",
};

const input = (over: Partial<CounterpartyDocumentInput>): CounterpartyDocumentInput => ({
  direction: "SALES",
  clientCondition: 1,
  counterpartyCondition: 1,
  voucherCode: 1,
  docType: 80,
  docNumber: VALID_CUIT,
  ...over,
});

describe("DOCUMENT_RULES — integridad", () => {
  it("ids únicos; filas ALLOWED con fuente y documentos del catálogo", () => {
    const ids = DOCUMENT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const catalog = new Set(DOCUMENT_TYPES.map((d) => d.code));
    for (const r of DOCUMENT_RULES.filter((x) => x.status === "ALLOWED")) {
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      expect(r.letters.length, r.id).toBeGreaterThan(0);
      for (const d of r.docTypes) expect(catalog.has(d), `${r.id} ${d}`).toBe(true);
    }
  });

  it("pendientes documentados: 99 sin identificar, clave fiscal extranjera, condiciones 8/10 y emisores 15/8/10", () => {
    expect(DOCUMENT_RULES.filter((r) => r.status === "PENDING").map((r) => r.id).sort()).toEqual(["DC4", "DV10", "DV12", "DV7"]);
    expect(DOCUMENT_RULES.find((r) => r.id === "DV7")?.docTypes).toEqual([DOC_TYPE_SIN_IDENTIFICAR]);
  });

  it("87 CDI no se incorpora en este cambio", () => {
    expect(DOCUMENT_TYPES.map((d) => d.code)).not.toContain(87);
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 5, voucherCode: 6, docType: 87, docNumber: VALID_CUIT }))).toMatchObject({
      ok: false,
      field: "counterpartyDocType",
      pending: false,
    });
  });

  it("la fuente general declara el texto vigente de RG 1415 Anexo II A según RG 5866/2026", () => {
    expect(DOCUMENT_RULES.find((r) => r.id === "DV1")?.basis).toMatch(/RG 1415, Anexo II, Apartado A \(texto vigente según RG 5866\/2026\)/);
  });
});

describe("allowedDocTypes — tabla 2B", () => {
  const cases: Array<[string, "SALES" | "PURCHASES", number, number, number, number[]]> = [
    ["V RI→RI A", "SALES", 1, 1, 1, [80]],
    ["V RI→RI M", "SALES", 1, 1, 51, [80]],
    ["V RI→RI T", "SALES", 1, 1, 195, [80]],
    ["V RI→Exento B", "SALES", 1, 4, 6, [80]],
    ["V RI→No alcanzado B", "SALES", 1, 15, 6, [80]],
    ["V Exento→Exento C", "SALES", 4, 4, 11, [80]],
    ["V RI→Monotributo A", "SALES", 1, 6, 1, [80]],
    ["V RI→Monotributo social B", "SALES", 1, 13, 6, [80]],
    ["V RI→No categorizado B", "SALES", 1, 7, 6, [80]],
    ["V RI→Consumidor final B", "SALES", 1, 5, 6, [80, 86, 91, 94, 96]],
    ["V Monotributo→Consumidor final C", "SALES", 6, 5, 11, [80, 86, 91, 94, 96]],
    ["V RI→Consumidor final T", "SALES", 1, 5, 195, [91, 94, 96]],
    ["V RI→Exterior E", "SALES", 1, 9, 19, [80]],
    ["V Exento→Exterior E", "SALES", 4, 9, 19, [80]],
    ["V RI→Exterior T", "SALES", 1, 9, 196, [80, 91, 94, 96]],
    ["V RI→8", "SALES", 1, 8, 1, []],
    ["V RI→10", "SALES", 1, 10, 6, []],
    ["C RI emite A a RI", "PURCHASES", 1, 1, 1, [80]],
    ["C RI emite B a Exento", "PURCHASES", 4, 1, 6, [80]],
    ["C RI emite T a RI", "PURCHASES", 1, 1, 197, [80]],
    ["C Monotributo emite C a RI", "PURCHASES", 1, 6, 11, [80]],
    ["C Monotributo social emite C a Monotributo", "PURCHASES", 6, 13, 11, [80]],
    ["C emisor 15", "PURCHASES", 1, 15, 11, []],
    ["C emisor 8", "PURCHASES", 1, 8, 1, []],
  ];
  it.each(cases)("%s", (_name, direction, client, counterparty, code, expected) => {
    expect(allowedDocTypes(direction, client, counterparty, code)).toEqual(expected);
  });

  it.each([
    [4, 11],
    [4, 12],
    [4, 13],
    [6, 11],
    [6, 12],
    [6, 13],
  ])("V cliente %s → Responsable Inscripto, código %s: sólo CUIT (80)", (client, code) => {
    expect(allowedDocTypes("SALES", client, 1, code)).toEqual([80]);
  });

  it("condiciones desconocidas o código fuera del catálogo -> nada", () => {
    expect(allowedDocTypes("SALES", null, 1, 1)).toEqual([]);
    expect(allowedDocTypes("SALES", 1, null, 1)).toEqual([]);
    expect(allowedDocTypes("SALES", 1, 1, 63)).toEqual([]);
  });
});

describe("checkCounterpartyDocument", () => {
  it("receptor categorizado exige CUIT: DNI -> rechazado (no pendiente)", () => {
    for (const receiver of [1, 4, 6, 7, 13, 15, 16]) {
      const code = receiver === 1 ? 1 : 6;
      expect(checkCounterpartyDocument(input({ counterpartyCondition: receiver, voucherCode: code, docType: 96, docNumber: "12345678" })), String(receiver))
        .toMatchObject({ ok: false, field: "counterpartyDocType", pending: false });
    }
  });

  it("CUIT/CUIL: acepta separadores, normaliza a dígitos y valida el dígito verificador", () => {
    expect(checkCounterpartyDocument(input({ docNumber: "30-99999999-5" }))).toEqual({
      ok: true,
      ruleId: "DV1",
      docType: 80,
      docNumber: VALID_CUIT,
      partialValidation: false,
    });
    expect(checkCounterpartyDocument(input({ docNumber: "30999999996" }))).toMatchObject({ ok: false, field: "counterpartyDocNumber" });
    expect(checkCounterpartyDocument(input({ docNumber: "3099999999" }))).toMatchObject({ ok: false, field: "counterpartyDocNumber" });
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 5, voucherCode: 6, docType: 86, docNumber: VALID_CUIL })))
      .toMatchObject({ ok: true, ruleId: "DV6" });
  });

  it("consumidor final: DNI, documentos extranjeros y CUIT admitidos; 99 pendiente y bloqueado", () => {
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 5, voucherCode: 6, docType: 96, docNumber: "12.345.678" })))
      .toEqual({ ok: true, ruleId: "DV6", docType: 96, docNumber: "12345678", partialValidation: false });
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 5, voucherCode: 6, docType: 94, docNumber: "p1234567" })))
      .toMatchObject({ ok: true, docNumber: "P1234567" });
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 5, voucherCode: 6, docType: 91, docNumber: "AB-123" })))
      .toMatchObject({ ok: false, field: "counterpartyDocNumber" });
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 5, voucherCode: 6, docType: 99, docNumber: "0" })))
      .toMatchObject({ ok: false, field: "counterpartyDocType", pending: true });
  });

  it("exportación: 80 como CUIT o CUIT País con 11 dígitos numéricos y validación parcial; otro documento -> pendiente", () => {
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 9, voucherCode: 19, docNumber: "50000000016" })))
      .toEqual({ ok: true, ruleId: "DV9", docType: 80, docNumber: "50000000016", partialValidation: true });
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 9, voucherCode: 19, docNumber: "50-00000001-6" })))
      .toMatchObject({ ok: false, field: "counterpartyDocNumber" });
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 9, voucherCode: 19, docType: 96, docNumber: "12345678" })))
      .toMatchObject({ ok: false, field: "counterpartyDocType", pending: true });
  });

  it("TurIVA: receptor 9 con 80 (CUIT País) parcial; receptor 5 con 80 rechazado", () => {
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 9, voucherCode: 195, docNumber: "50000000016" })))
      .toMatchObject({ ok: true, ruleId: "DV11", partialValidation: true });
    expect(checkCounterpartyDocument(input({ counterpartyCondition: 5, voucherCode: 195, docType: 80 })))
      .toMatchObject({ ok: false, field: "counterpartyDocType", pending: false });
  });

  it("condición 15 depende de la dirección: venta RI → No alcanzado B aceptada; compra con emisor 15 pendiente", () => {
    for (const code of [6, 7, 8]) {
      expect(checkCounterpartyDocument(input({ counterpartyCondition: 15, voucherCode: code })), String(code))
        .toMatchObject({ ok: true, ruleId: "DV3", docType: 80, partialValidation: false });
      expect(allowedDocTypes("SALES", 1, 15, code), String(code)).toEqual([80]);
    }
    expect(checkCounterpartyDocument(input({ direction: "PURCHASES", clientCondition: 1, counterpartyCondition: 15, voucherCode: 11 })))
      .toMatchObject({ ok: false, field: "counterpartyDocType", pending: true });
    expect(allowedDocTypes("PURCHASES", 1, 15, 11)).toEqual([]);
    for (const c of [8, 10]) {
      expect(allowedDocTypes("SALES", 1, c, 6), `venta a ${c}`).toEqual([]);
      expect(allowedDocTypes("PURCHASES", 1, c, 1), `compra de ${c}`).toEqual([]);
    }
  });

  it("venta C de Exento (4) o Monotributo (6) a Responsable Inscripto: CUIT aceptado (DV13); otros documentos rechazados sin pendiente", () => {
    for (const client of [4, 6]) {
      for (const code of [11, 12, 13]) {
        const tag = `cliente ${client} código ${code}`;
        expect(checkCounterpartyDocument(input({ clientCondition: client, counterpartyCondition: 1, voucherCode: code, docNumber: "30-99999999-5" })), tag)
          .toEqual({ ok: true, ruleId: "DV13", docType: 80, docNumber: VALID_CUIT, partialValidation: false });
        expect(checkCounterpartyDocument(input({ clientCondition: client, counterpartyCondition: 1, voucherCode: code, docNumber: "30999999996" })), tag)
          .toMatchObject({ ok: false, field: "counterpartyDocNumber" });
        for (const docType of [86, 91, 94, 96, 99]) {
          expect(
            checkCounterpartyDocument(input({ clientCondition: client, counterpartyCondition: 1, voucherCode: code, docType, docNumber: NUMBER_FOR[docType] })),
            `${tag} doc ${docType}`,
          ).toMatchObject({ ok: false, field: "counterpartyDocType", pending: false });
        }
      }
    }
    // DV13 no alcanza al emisor RI (su clase C no existe) ni a otras clases.
    expect(allowedDocTypes("SALES", 1, 1, 11)).toEqual([]);
    expect(allowedDocTypes("SALES", 6, 1, 6)).toEqual([]);
  });

  it("compras: emisores 15, 8 y 10 pendientes; condiciones nulas rechazadas", () => {
    for (const issuer of [15, 8, 10]) {
      expect(checkCounterpartyDocument(input({ direction: "PURCHASES", counterpartyCondition: issuer, voucherCode: 11 })), String(issuer))
        .toMatchObject({ ok: false, pending: true });
    }
    expect(checkCounterpartyDocument(input({ clientCondition: null }))).toMatchObject({ ok: false, field: "counterpartyDocType" });
    expect(checkCounterpartyDocument(input({ counterpartyCondition: null }))).toMatchObject({ ok: false, field: "counterpartyDocType" });
  });
});

describe("allowedDocumentRule / pendingDocumentRules — metadata normativa sin número", () => {
  it("devuelve sólo metadata de la fila (sin número de documento)", () => {
    const meta = allowedDocumentRule("SALES", 1, 1, 1, 80);
    expect(Object.keys(meta ?? {}).sort()).toEqual(["basis", "cuitPais", "docTypes", "id", "partialValidation", "sources", "status"]);
    expect(meta).toMatchObject({ id: "DV1", status: "ALLOWED", cuitPais: false, partialValidation: false });
  });

  it("conserva la validación parcial de CUIT País y TurIVA", () => {
    expect(allowedDocumentRule("SALES", 1, 9, 19, 80)).toMatchObject({ id: "DV9", cuitPais: true, partialValidation: true });
    expect(allowedDocumentRule("SALES", 1, 9, 195, 80)).toMatchObject({ id: "DV11", cuitPais: true, partialValidation: true });
    expect(allowedDocumentRule("SALES", 1, 5, 196, 94)).toMatchObject({ id: "DV8", cuitPais: false, partialValidation: true });
    expect(allowedDocumentRule("SALES", 1, 1, 197, 80)).toMatchObject({ id: "DV2", partialValidation: true });
    expect(allowedDocumentRule("PURCHASES", 1, 1, 195, 80)).toMatchObject({ id: "DC2", partialValidation: true });
  });

  it("documento no admitido, condiciones nulas o código fuera del catálogo -> null", () => {
    expect(allowedDocumentRule("SALES", 1, 5, 6, 99)).toBeNull();
    expect(allowedDocumentRule("SALES", 1, 5, 6, 87)).toBeNull();
    expect(allowedDocumentRule("SALES", null, 1, 1, 80)).toBeNull();
    expect(allowedDocumentRule("SALES", 1, null, 1, 80)).toBeNull();
    expect(allowedDocumentRule("SALES", 1, 1, 63, 80)).toBeNull();
  });

  it("filas PENDING aplicables: 99 del consumidor final y clave fiscal extranjera de exportación", () => {
    expect(pendingDocumentRules("SALES", 1, 5, 6).map((r) => [r.id, r.docTypes])).toEqual([["DV7", [99]]]);
    expect(pendingDocumentRules("SALES", 1, 9, 19).map((r) => [r.id, r.docTypes])).toEqual([["DV10", []]]);
    expect(pendingDocumentRules("SALES", 1, 1, 1)).toEqual([]);
  });
});

describe("allowedDocTypes, allowedDocumentRule, pendingDocumentRules y checkCounterpartyDocument nunca divergen", () => {
  // Números reales de prueba, uno válido por formato (sólo para consultar a checkCounterpartyDocument).
  const REAL: Record<number, string> = { ...NUMBER_FOR, 87: "12345678" };
  const CUIT_PAIS = "50000000016";

  it("barrido: direcciones × condiciones (incl. null) × códigos (incl. 063) × documentos (incl. 87)", () => {
    let checked = 0;
    for (const direction of ["SALES", "PURCHASES"] as const) {
      for (const client of [null, 1, 4, 6]) {
        for (const cp of [null, ...VAT_CONDITIONS.map((c) => c.code)]) {
          for (const code of [...VOUCHER_TYPES.map((v) => v.code), 63]) {
            const offered = allowedDocTypes(direction, client, cp, code);
            const pending = pendingDocumentRules(direction, client, cp, code);
            for (const docType of [...DOCUMENT_TYPES.map((d) => d.code), 87]) {
              const tag = JSON.stringify({ direction, client, cp, code, docType });
              const meta = allowedDocumentRule(direction, client, cp, code, docType);
              expect(offered.includes(docType), tag).toBe(meta !== null);

              const check = checkCounterpartyDocument({ direction, clientCondition: client, counterpartyCondition: cp, voucherCode: code, docType, docNumber: REAL[docType] });
              if (meta) {
                expect(check, tag).toEqual({ ok: true, ruleId: meta.id, docType, docNumber: expect.any(String), partialValidation: meta.partialValidation });
                if (meta.cuitPais) {
                  expect(checkCounterpartyDocument({ direction, clientCondition: client, counterpartyCondition: cp, voucherCode: code, docType, docNumber: CUIT_PAIS }).ok, tag).toBe(true);
                }
              } else {
                expect(check.ok, tag).toBe(false);
                const inCatalog = DOCUMENT_TYPES.some((d) => d.code === docType);
                const expectedPending =
                  client !== null && cp !== null && inCatalog && pending.some((r) => r.docTypes.length === 0 || r.docTypes.includes(docType));
                if (!check.ok) expect(check.pending, tag).toBe(expectedPending);
              }
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});

describe("CUIT de la contraparte (casos del contrato anterior, ahora por document-rules)", () => {
  it.each([["30999999995"], ["30 99999999 5"], ["30.99999999.5"], ["30-99999999-5"]])("%s -> normalizado a 11 dígitos", (docNumber) => {
    for (const direction of ["SALES", "PURCHASES"] as const) {
      expect(checkCounterpartyDocument(input({ direction, docNumber })), `${direction} ${docNumber}`).toMatchObject({
        ok: true,
        docType: 80,
        docNumber: VALID_CUIT,
      });
    }
  });

  it.each([["30-1"], ["30-99999999-1"], ["30-9999999X-5"], [""], ["   "]])("%s -> 422 counterpartyDocNumber", (docNumber) => {
    for (const direction of ["SALES", "PURCHASES"] as const) {
      expect(checkCounterpartyDocument(input({ direction, docNumber })), `${direction} ${docNumber}`).toMatchObject({
        ok: false,
        field: "counterpartyDocNumber",
        pending: false,
      });
    }
  });
});

describe("checkCounterpartyDocument sigue validando el número real", () => {
  it("formatos y dígito verificador sin cambios", () => {
    const sale = (over: Partial<CounterpartyDocumentInput>) => checkCounterpartyDocument(input(over));
    expect(sale({ docNumber: "30-99999999-5" })).toEqual({ ok: true, ruleId: "DV1", docType: 80, docNumber: VALID_CUIT, partialValidation: false });
    expect(sale({ docNumber: "30-99999999-4" })).toEqual({ ok: false, field: "counterpartyDocNumber", error: "dígito verificador incorrecto", pending: false });
    expect(sale({ docNumber: "   " })).toEqual({ ok: false, field: "counterpartyDocNumber", error: "número de documento requerido", pending: false });
    expect(sale({ counterpartyCondition: 9, voucherCode: 19, docNumber: "5000000001A" })).toEqual({
      ok: false,
      field: "counterpartyDocNumber",
      error: "debe tener 11 dígitos numéricos",
      pending: false,
    });
    expect(sale({ counterpartyCondition: 5, voucherCode: 6, docType: 96, docNumber: "12A45678" })).toEqual({
      ok: false,
      field: "counterpartyDocNumber",
      error: "el DNI sólo admite dígitos",
      pending: false,
    });
    expect(sale({ counterpartyCondition: 5, voucherCode: 6, docType: 91, docNumber: "ab 123" })).toMatchObject({ ok: false, field: "counterpartyDocNumber" });
    expect(sale({ counterpartyCondition: 5, voucherCode: 6, docType: 91, docNumber: "ab123" })).toMatchObject({ ok: true, docNumber: "AB123" });
  });
});

describe("coherencia con la matriz TurIVA (checkVoucherCombination)", () => {
  it("ventas 195: el documento aceptado por document-rules coincide con el aceptado por la matriz", () => {
    for (const receiver of [1, 5, 9]) {
      for (const docType of [80, 86, 91, 94, 96, 99]) {
        const docOk = checkCounterpartyDocument(
          input({ counterpartyCondition: receiver, voucherCode: 195, docType, docNumber: NUMBER_FOR[docType] }),
        ).ok;
        const matrixOk = checkVoucherCombination({
          direction: "SALES",
          clientCondition: 1,
          counterpartyCondition: receiver,
          voucherCode: 195,
          dateIso: "2026-05-10",
          voucherVariant: null,
          turivaRelationCode: receiver === 1 ? "0002" : "0001",
          counterpartyDocType: docType,
        }).ok;
        expect(docOk, `receptor ${receiver} doc ${docType}`).toBe(matrixOk);
      }
    }
  });
});

describe("coherencia con la matriz: ventas C de Exento/Monotributo a Responsable Inscripto", () => {
  it("toda combinación ALLOWED de la matriz (cliente 4/6 → 1, códigos 011–013) tiene cobertura documental con CUIT", () => {
    const rows = VOUCHER_MATRIX.filter((r) => r.status === "ALLOWED" && r.direction === "SALES" && r.receivers.includes(1));
    let covered = 0;
    for (const client of [4, 6]) {
      for (const code of [11, 12, 13]) {
        const row = rows.find((r) => r.issuers.includes(client) && r.codes.includes(code));
        expect(row, `matriz cliente ${client} código ${code}`).toBeDefined();
        const matrix = checkVoucherCombination({
          direction: "SALES",
          clientCondition: client,
          counterpartyCondition: 1,
          voucherCode: code,
          dateIso: "2026-05-10",
          voucherVariant: null,
          turivaRelationCode: null,
          counterpartyDocType: 80,
        });
        expect(matrix, `matriz cliente ${client} código ${code}`).toMatchObject({ ok: true });
        expect(allowedDocTypes("SALES", client, 1, code), `documentos cliente ${client} código ${code}`).toContain(80);
        expect(checkCounterpartyDocument(input({ clientCondition: client, counterpartyCondition: 1, voucherCode: code })).ok).toBe(true);
        covered++;
      }
    }
    expect(covered).toBe(6);
  });
});
