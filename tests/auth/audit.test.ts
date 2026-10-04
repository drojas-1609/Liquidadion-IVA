import { describe, it, expect, vi } from "vitest";
import {
  AUDIT_ACTIONS,
  sanitizeAuditMetadata,
  recordAudit,
  type AuditTxClient,
} from "@/lib/auth/audit";

describe("sanitizeAuditMetadata — allow-list por acción", () => {
  it("client.create: SÓLO `condition`, nunca `cuit` ni importes", () => {
    const out = sanitizeAuditMetadata("client.create", {
      condition: "Responsable Inscripto",
      cuit: "30-12345678-1",
      name: "ACME SA",
      defaultIibbRate: "3.5",
      organizationId: "org_x",
    });
    expect(out).toEqual({ condition: "Responsable Inscripto" });
    expect(JSON.stringify(out)).not.toMatch(/30-12345678-1|iibb|org_x|ACME/i);
  });

  it("client.create sin condition útil -> {}", () => {
    expect(sanitizeAuditMetadata("client.create", { cuit: "30-11111111-8" })).toEqual({});
  });

  it("period.create: clientId, month, year", () => {
    expect(
      sanitizeAuditMetadata("period.create", { clientId: "c1", month: 5, year: 2026, extra: "x" }),
    ).toEqual({ clientId: "c1", month: 5, year: 2026 });
  });

  it("invoice.create: periodId, category, voucherCode (sin importes, contraparte ni `type` heredado)", () => {
    const out = sanitizeAuditMetadata("invoice.create", {
      periodId: "p1",
      category: "SALES",
      voucherCode: 1,
      type: "FC A",
      netAmount: "1000.00",
      vatAmount: "210.00",
      totalAmount: "1210.00",
      entityName: "Proveedor SA",
      entityCuit: "30-9",
    });
    expect(out).toEqual({ periodId: "p1", category: "SALES", voucherCode: 1 });
    expect(JSON.stringify(out)).not.toMatch(/1000|210|1210|Proveedor|30-9/);
  });

  it("invoice.update: identificación antes/después y changedFields (sin importes, alícuotas ni contraparte)", () => {
    const out = sanitizeAuditMetadata("invoice.update", {
      periodId: "p1",
      category: "PURCHASES",
      voucherCodeBefore: 1,
      voucherCodeAfter: 3,
      pointOfSaleBefore: 1,
      pointOfSaleAfter: 2,
      numberBefore: 1001,
      numberAfter: 1002,
      changedFields: "voucherCode,pointOfSale,number,netAmount",
      netAmount: "1000.00",
      vatRate: "21",
      counterpartyDocNumber: "30999999995",
      counterpartyName: "Proveedor SA",
      before: { netAmount: "1000.00" },
      body: { number: "1002" },
    });
    expect(out).toEqual({
      periodId: "p1",
      category: "PURCHASES",
      voucherCodeBefore: 1,
      voucherCodeAfter: 3,
      pointOfSaleBefore: 1,
      pointOfSaleAfter: 2,
      numberBefore: 1001,
      numberAfter: 1002,
      changedFields: "voucherCode,pointOfSale,number,netAmount",
    });
    expect(JSON.stringify(out)).not.toMatch(/1000\.00|"21"|30999999995|Proveedor/);
  });

  it("invoice.delete: periodId, category, voucherCode, pointOfSale, number (sin importes ni contraparte)", () => {
    const out = sanitizeAuditMetadata("invoice.delete", {
      periodId: "p1",
      category: "SALES",
      voucherCode: 1,
      pointOfSale: 1,
      number: 1001,
      netAmount: "1000.00",
      vatRate: "21",
      counterpartyDocNumber: "30999999995",
      counterpartyName: "Cliente SA",
      changedFields: "number",
    });
    expect(out).toEqual({ periodId: "p1", category: "SALES", voucherCode: 1, pointOfSale: 1, number: 1001 });
    expect(JSON.stringify(out)).not.toMatch(/1000\.00|"21"|30999999995|Cliente SA/);
  });

  it("taxrecord.create: periodId, type", () => {
    expect(
      sanitizeAuditMetadata("taxrecord.create", { periodId: "p1", type: "RETENCION IVA", amount: "5.00" }),
    ).toEqual({ periodId: "p1", type: "RETENCION IVA" });
  });

  it("taxrecord.create: sin cambios (descarta changedFields, typeBefore, descripción y fecha)", () => {
    expect(
      sanitizeAuditMetadata("taxrecord.create", {
        periodId: "p1",
        type: "SIRCREB",
        typeBefore: "RETENCION IVA",
        changedFields: ["type"],
        description: "Banco X",
        date: "2026-05-10",
      }),
    ).toEqual({ periodId: "p1", type: "SIRCREB" });
  });

  describe("taxrecord.update", () => {
    const valid = {
      periodId: "p1",
      typeBefore: "RETENCION IVA",
      typeAfter: "PERCEPCION IVA",
      changedFields: ["type", "amount"],
    };

    it("metadata exacta: periodId, typeBefore, typeAfter y changedFields (texto en orden canónico)", () => {
      expect(sanitizeAuditMetadata("taxrecord.update", valid)).toEqual({
        periodId: "p1",
        typeBefore: "RETENCION IVA",
        typeAfter: "PERCEPCION IVA",
        changedFields: "type,amount",
      });
    });

    it("descarta importe, descripción, fecha, CUIT, nombres, ids de organización/usuario, payloads, errores y claves arbitrarias", () => {
      const out = sanitizeAuditMetadata("taxrecord.update", {
        ...valid,
        amount: "2500.00",
        amountBefore: "1000.00",
        amountAfter: "2500.00",
        description: "Banco Galicia",
        descriptionBefore: "Banco Nación",
        date: "2026-05-10",
        dateBefore: "2026-05-01",
        cuit: "20-12345678-6",
        clientName: "Alfa SA",
        organizationId: "org_a",
        actorProfileId: "aaaaaaaa-0000-4000-8000-000000000001",
        updatedById: "aaaaaaaa-0000-4000-8000-000000000001",
        targetId: "t1",
        body: { amount: "2500.00" },
        payload: '{"amount":"2500.00"}',
        error: "violación de restricción",
        anything: "value",
      });
      expect(Object.keys(out).sort()).toEqual(["changedFields", "periodId", "typeAfter", "typeBefore"]);
      expect(JSON.stringify(out)).not.toMatch(/2500|1000|Galicia|Nación|2026-05|20-12345678-6|Alfa|org_a|aaaaaaaa|t1|violación/);
    });

    it.each([
      ["conjunto completo", ["date", "type", "amount", "description"], "date,type,amount,description"],
      ["conjunto completo en otro orden", ["description", "amount", "type", "date"], "date,type,amount,description"],
      ["subconjunto", ["amount"], "amount"],
      ["subconjunto en otro orden", ["description", "date"], "date,description"],
      ["duplicados", ["amount", "amount", "type", "amount"], "type,amount"],
      ["campos desconocidos descartados", ["amount", "periodId", "organizationId", "notes"], "amount"],
      ["mayúsculas o espacios no coinciden", ["Amount", " date", "type "], undefined],
      ["strings vacíos", ["", "type", ""], "type"],
      ["elementos no-string", [1, null, { name: "date" }, ["type"], true, "description"], "description"],
      ["sólo desconocidos", ["foo", "bar"], undefined],
      ["array vacío", [], undefined],
    ])("changedFields: %s", (_l, changedFields, expected) => {
      const out = sanitizeAuditMetadata("taxrecord.update", { ...valid, changedFields }) as Record<string, unknown>;
      if (expected === undefined) expect(out).not.toHaveProperty("changedFields");
      else expect(out.changedFields).toBe(expected);
      expect(out).toMatchObject({ periodId: "p1", typeBefore: "RETENCION IVA", typeAfter: "PERCEPCION IVA" });
    });

    it.each([
      ["texto separado por comas", "type,amount"],
      ["texto simple", "amount"],
      ["objeto", { 0: "amount" }],
      ["número", 1],
      ["null", null],
      ["ausente", undefined],
    ])("changedFields que no es un array (%s) -> se omite", (_l, changedFields) => {
      expect(sanitizeAuditMetadata("taxrecord.update", { ...valid, changedFields })).toEqual({
        periodId: "p1",
        typeBefore: "RETENCION IVA",
        typeAfter: "PERCEPCION IVA",
      });
    });

    it("typeBefore histórico fuera del catálogo: se conserva tal cual (sin validar contra el catálogo)", () => {
      const out = sanitizeAuditMetadata("taxrecord.update", { ...valid, typeBefore: "retencion ganancias (manual)" });
      expect(out).toMatchObject({ typeBefore: "retencion ganancias (manual)", typeAfter: "PERCEPCION IVA" });
    });

    it("typeBefore histórico: se sanea con los límites vigentes (recorte a 256, secretos descartados)", () => {
      const long = "TIPO VIEJO ".repeat(40);
      const cut = sanitizeAuditMetadata("taxrecord.update", { ...valid, typeBefore: long }) as Record<string, unknown>;
      expect(cut.typeBefore).toBe(long.slice(0, 256));
      const secret = sanitizeAuditMetadata("taxrecord.update", { ...valid, typeBefore: "token=abc" });
      expect(secret).not.toHaveProperty("typeBefore");
      expect(sanitizeAuditMetadata("taxrecord.update", { ...valid, typeBefore: { v: "x" } })).not.toHaveProperty("typeBefore");
    });
  });

  describe("taxrecord.delete", () => {
    it("metadata exacta: periodId y type", () => {
      expect(sanitizeAuditMetadata("taxrecord.delete", { periodId: "p1", type: "SIRTAC" })).toEqual({ periodId: "p1", type: "SIRTAC" });
    });

    it("tipo histórico fuera del catálogo: se conserva tal cual", () => {
      expect(sanitizeAuditMetadata("taxrecord.delete", { periodId: "p1", type: "OTRO" })).toEqual({ periodId: "p1", type: "OTRO" });
    });

    it("descarta importe, descripción, fecha, changedFields, typeBefore, ids y claves arbitrarias", () => {
      const out = sanitizeAuditMetadata("taxrecord.delete", {
        periodId: "p1",
        type: "RETENCION IIBB",
        amount: "2500.00",
        description: "Banco Galicia",
        date: "2026-05-10",
        changedFields: ["amount"],
        typeBefore: "X",
        organizationId: "org_a",
        actorProfileId: "aaaaaaaa-0000-4000-8000-000000000001",
        cuit: "20-12345678-6",
        anything: "value",
      });
      expect(out).toEqual({ periodId: "p1", type: "RETENCION IIBB" });
    });
  });

  it("changedFields de las demás acciones mantiene su contrato (texto; un array se sigue descartando)", () => {
    expect(sanitizeAuditMetadata("invoice.update", { periodId: "p1", changedFields: "number,netAmount" })).toEqual({ periodId: "p1", changedFields: "number,netAmount" });
    expect(sanitizeAuditMetadata("invoice.update", { periodId: "p1", changedFields: ["number"] })).toEqual({ periodId: "p1" });
    expect(sanitizeAuditMetadata("client.update", { changedFields: ["name"] })).toEqual({});
    expect(sanitizeAuditMetadata("period.vat_settings_change", { changedFields: ["turivaIncluded"] })).toEqual({});
  });

  it("liquidation.export: referencias + conteos, nunca importes ni contenido", () => {
    const out = sanitizeAuditMetadata("liquidation.export", {
      periodId: "p1",
      clientId: "c1",
      month: 5,
      year: 2026,
      invoiceCount: 12,
      taxRecordCount: 3,
      buffer: "PKbinario…",
      ivaPayable: "999.99",
    });
    expect(out).toEqual({
      periodId: "p1",
      clientId: "c1",
      month: 5,
      year: 2026,
      invoiceCount: 12,
      taxRecordCount: 3,
    });
    expect(JSON.stringify(out)).not.toMatch(/PK|binario|999\.99/);
  });

  it("client.update: sólo changedFields y condition; nunca cuit, nombre ni dirección", () => {
    const out = sanitizeAuditMetadata("client.update", {
      changedFields: "name,cuit,address",
      condition: "Monotributo",
      cuit: "20-12345678-6",
      name: "Alfa SA",
      address: "Calle 123",
    });
    expect(out).toEqual({ changedFields: "name,cuit,address", condition: "Monotributo" });
  });

  it("client.delete: sólo condition", () => {
    expect(
      sanitizeAuditMetadata("client.delete", {
        condition: "Exento",
        cuit: "20-12345678-6",
        name: "Alfa SA",
        address: "Calle 123",
      }),
    ).toEqual({ condition: "Exento" });
  });

  it("period.delete: sólo clientId, month y year", () => {
    expect(
      sanitizeAuditMetadata("period.delete", {
        clientId: "c1",
        month: 4,
        year: 2026,
        organizationId: "org",
        cuit: "20-12345678-6",
        invoices: [{ total: "999.99" }],
      }),
    ).toEqual({ clientId: "c1", month: 4, year: 2026 });
  });

  it("period.vat_settings_change: sólo los 9 campos aprobados; coeficientes como strings exactos", () => {
    const out = sanitizeAuditMetadata("period.vat_settings_change", {
      changedFields: "creditProrationMode,globalCoefficient",
      prorationModeBefore: "NONE",
      prorationModeAfter: "GLOBAL",
      coefficientBefore: null,
      coefficientAfter: "0.1234567891",
      coefficientStatusBefore: null,
      coefficientStatusAfter: "PROVISIONAL",
      turivaIncludedBefore: false,
      turivaIncludedAfter: true,
      organizationId: "org",
      cuit: "20-12345678-6",
      clientName: "Alfa SA",
      invoiceTotal: "1210.00",
    });
    expect(out).toEqual({
      changedFields: "creditProrationMode,globalCoefficient",
      prorationModeBefore: "NONE",
      prorationModeAfter: "GLOBAL",
      coefficientBefore: null,
      coefficientAfter: "0.1234567891",
      coefficientStatusBefore: null,
      coefficientStatusAfter: "PROVISIONAL",
      turivaIncludedBefore: false,
      turivaIncludedAfter: true,
    });
    // el coeficiente se conserva exacto (10 decimales), sin pasar por float
    expect(typeof (out as Record<string, unknown>).coefficientAfter).toBe("string");
    expect(JSON.stringify(out)).not.toMatch(/20-12345678-6|Alfa SA|1210/);
  });

  it("acción reservada (futura) -> siempre {}", () => {
    for (const a of ["period.update", "member.role_change", "org.config_change"]) {
      expect(sanitizeAuditMetadata(a, { anything: "value", clientId: "c1" })).toEqual({});
    }
  });

  it("descarta valores que parezcan secretos aunque estén en una clave permitida", () => {
    expect(
      sanitizeAuditMetadata("period.create", {
        clientId: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload",
        month: 1,
        year: 2026,
      }),
    ).toEqual({ month: 1, year: 2026 });
    expect(
      sanitizeAuditMetadata("invoice.create", {
        periodId: "postgresql://user:pass@host:5432/db",
        category: "SALES",
        voucherCode: 1,
      }),
    ).toEqual({ category: "SALES", voucherCode: 1 });
  });

  it("descarta objetos/arrays anidados (sólo escalares)", () => {
    expect(
      sanitizeAuditMetadata("period.create", { clientId: { nested: true }, month: [1], year: 2026 }),
    ).toEqual({ year: 2026 });
  });

  it("recorta strings largos a 256 y respeta el tope de 2KB", () => {
    const long = "x".repeat(5000);
    const out = sanitizeAuditMetadata("invoice.create", { category: long, periodId: "p1", voucherCode: 1 });
    expect((out as Record<string, string>).category.length).toBe(256);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(2048);
  });

  it("input no-objeto -> {}", () => {
    expect(sanitizeAuditMetadata("period.create", null)).toEqual({});
    expect(sanitizeAuditMetadata("period.create", "texto")).toEqual({});
    expect(sanitizeAuditMetadata("period.create", [1, 2, 3])).toEqual({});
  });

  it("nunca contiene claves de secreto típicas", () => {
    const out = sanitizeAuditMetadata("client.create", {
      condition: "RI",
      password: "hunter2",
      access_token: "abc",
      cookie: "sb-x=y",
    });
    expect(Object.keys(out)).toEqual(["condition"]);
  });
});

describe("recordAudit", () => {
  function txMock() {
    const create = vi.fn<(args: { data: unknown }) => Promise<{ id: string }>>(async () => ({
      id: "audit_1",
    }));
    const tx: AuditTxClient = { auditLog: { create } };
    return { tx, create };
  }

  it("inserta una fila con los campos correctos y metadata saneada", async () => {
    const { tx, create } = txMock();
    await recordAudit(tx, {
      organizationId: "org_a",
      actorProfileId: "prof_1",
      action: "client.create",
      targetType: "Client",
      targetId: "c1",
      metadata: { condition: "RI", cuit: "30-11111111-8" },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: "org_a",
        actorProfileId: "prof_1",
        action: "client.create",
        targetType: "Client",
        targetId: "c1",
        metadata: { condition: "RI" },
      },
    });
  });

  it("rechaza acciones fuera de AUDIT_ACTIONS (defensa en profundidad)", async () => {
    const { tx, create } = txMock();
    const badInput = {
      organizationId: "o",
      actorProfileId: "p",
      action: "client.destroy_all",
      targetType: "Client",
      targetId: "c1",
      metadata: {},
    } as unknown as Parameters<typeof recordAudit>[1];
    await expect(recordAudit(tx, badInput)).rejects.toThrow(/no permitida/);
    expect(create).not.toHaveBeenCalled();
  });

  it("si auditLog.create falla, el error se propaga (rollback lo maneja $transaction)", async () => {
    const tx: AuditTxClient = {
      auditLog: {
        create: async () => {
          throw new Error("db down");
        },
      },
    };
    await expect(
      recordAudit(tx, {
        organizationId: "o",
        actorProfileId: "p",
        action: "period.create",
        targetType: "Period",
        targetId: "p1",
        metadata: { clientId: "c1", month: 1, year: 2026 },
      }),
    ).rejects.toThrow("db down");
  });

  it("AUDIT_ACTIONS incluye la corrección de comprobantes manuales", () => {
    expect(AUDIT_ACTIONS).toContain("invoice.update");
    expect(AUDIT_ACTIONS).toContain("invoice.delete");
  });

  it("AUDIT_ACTIONS incluye las 5 emitidas en 3B", () => {
    for (const a of [
      "client.create",
      "period.create",
      "invoice.create",
      "taxrecord.create",
      "liquidation.export",
    ]) {
      expect(AUDIT_ACTIONS).toContain(a);
    }
  });
});
