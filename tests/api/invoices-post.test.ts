import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  claims: { throw: null as unknown, value: null as unknown },
  db: { current: null as unknown },
}));
vi.mock("@/lib/auth/claims", () => ({
  getAuthClaims: async () => {
    if (H.claims.throw) throw H.claims.throw;
    return H.claims.value;
  },
}));
vi.mock("@/lib/prisma", () => ({
  get default() {
    return H.db.current;
  },
}));

import {
  freshDbMock,
  freshRecorder,
  wireDb,
  makeWorld,
  claimsFor,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  SUB_NO_PROFILE,
  ORG_A,
  ORG_B,
  periodRow,
  type World,
} from "./_harness";
import { Prisma } from "@prisma/client";
import { POST } from "@/app/api/invoices/route";
import { cuitCheckDigit } from "@/lib/cuit";
import { INVOICE_CONTRACT_OUTDATED_MESSAGE } from "@/lib/api-input";
import { TURIVA_NOT_INCLUDED_MESSAGE } from "@/lib/invoice-model";
import { LEGEND_OPERACION_SUJETA_A_RETENCION } from "@/lib/arca/voucher-legal-class";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

/** Mundo por defecto: c_a Responsable Inscripto, p_a = 05/2026 (ORG_A). */
const setWorld = (patch: (w: World) => void = () => {}) => {
  world = makeWorld();
  patch(world);
  wireDb(db, world, rec);
};
const clientCondition = (condition: string) => setWorld((w) => (w.clients[0].condition = condition));
const turivaIncluded = (value: boolean) =>
  setWorld((w) => (w.vatSettings = [{ periodId: "p_a", organizationId: ORG_A, turivaIncluded: value, creditProrationMode: "NONE" }]));

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  setWorld();
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

const post = (bodyText: string | undefined) =>
  POST(new Request("http://localhost/api/invoices", { method: "POST", body: bodyText }));
const jbody = (o: unknown) => JSON.stringify(o);
const str = (d: unknown) => (d instanceof Prisma.Decimal ? d.toFixed(2) : d);

/** CUIT/CUIL válido: base de 10 dígitos + dígito verificador. */
const withCheckDigit = (base: string) => `${base}${cuitCheckDigit(base)}`;

const RI_CUIT = { name: "Proveedor SA", docType: 80, docNumber: "30-99999999-5", vatConditionCode: 1 };

// Compra A de un Responsable Inscripto (cliente RI): matriz C1, documento DC1.
const valid = {
  contractVersion: 2,
  category: "PURCHASES",
  periodId: "p_a",
  date: "2026-05-10",
  voucherCode: 1,
  voucherVariant: "NONE",
  pointOfSale: 1,
  number: 1001,
  counterparty: RI_CUIT,
  turivaRelationCode: null,
  netAmount: "1000",
  vatRate: "21",
};
const sale = { ...valid, category: "SALES", counterparty: { ...RI_CUIT, name: "Cliente SA" } };
const consumer = (docType: number, docNumber: string) => ({ name: "Consumidor", docType, docNumber, vatConditionCode: 5 });
const saleB = { ...sale, voucherCode: 6, voucherVariant: null, counterparty: consumer(96, "12345678") };
// Venta T a turista no residente (TV2 / DV8), 01/04/2017 en adelante.
const saleT = {
  ...sale,
  voucherCode: 195,
  voucherVariant: null,
  turivaRelationCode: "0001",
  counterparty: { name: "Tourist", docType: 94, docNumber: "ab123456", vatConditionCode: 5 },
};
// Legacy completo: contrato anterior.
const legacyBody = {
  date: "2026-05-10",
  type: "FC A",
  pointOfSale: "1",
  number: "1001",
  entityName: "Proveedor SA",
  entityCuit: "30-99999999-5",
  netAmount: "1000",
  vatRate: "21",
  category: "PURCHASES",
  periodId: "p_a",
};

const expectNoWrite = () => {
  expect(db.invoice.create).not.toHaveBeenCalled();
  expect(rec.created.invoice).toBeUndefined();
  expect(rec.audits).toHaveLength(0);
};

describe("POST /api/invoices — contrato v2", () => {
  it.each([
    ["ausente", undefined],
    ["1", 1],
    ['"2"', "2"],
    ["null", null],
    ["3", 3],
  ])("contractVersion %s -> 422 contractVersion antes de acceder al período", async (_l, contractVersion) => {
    const body: Record<string, unknown> = { ...valid, contractVersion };
    if (contractVersion === undefined) delete body.contractVersion;
    const res = await post(jbody(body));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("contractVersion");
    expect(json.error.message).toBe(INVOICE_CONTRACT_OUTDATED_MESSAGE);
    expect(db.period.findUnique).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([["FC A"], ["FC B"], ["FC C"], ["FC T"], ["NC T"]])(
    "contrato anterior con type %s -> 422 contractVersion, sin acceso al período, transacción ni Prisma de escritura",
    async (type) => {
      const res = await post(jbody({ ...legacyBody, type }));
      expect(res.status).toBe(422);
      expect((await res.json()).field).toBe("contractVersion");
      expect(db.period.findUnique).not.toHaveBeenCalled();
      expect(db.period.findFirst).not.toHaveBeenCalled();
      expect(db.client.findFirst).not.toHaveBeenCalled();
      expect(db.invoice.findFirst).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expectNoWrite();
    },
  );

  it("JSON malformado o vacío -> 400 BAD_REQUEST", async () => {
    for (const bad of ["{", "", undefined]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("BAD_REQUEST");
    }
    expectNoWrite();
  });

  it.each([
    ["0", 0],
    ["-1", -1],
    ["1.5", 1.5],
    ["2147483648 (fuera de la columna Int)", 2147483648],
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
    ["texto '1'", "1"],
    ["texto '1e3'", "1e3"],
    ["null", null],
  ])("pointOfSale / number %s -> 422 con su field, sin acceso al período ni escritura", async (_l, value) => {
    for (const field of ["pointOfSale", "number"]) {
      const res = await post(jbody({ ...valid, [field]: value }));
      expect(res.status, `${field}=${String(value)}`).toBe(422);
      expect((await res.json()).field).toBe(field);
    }
    expect(db.period.findUnique).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("pointOfSale / number en 1..2147483647 (máximo de la columna Int) -> 201 y se persisten tal cual", async () => {
    const res = await post(jbody({ ...valid, pointOfSale: 99999, number: 2147483647 }));
    expect(res.status).toBe(201);
    expect(rec.created.invoice).toMatchObject({ pointOfSale: 99999, number: 2147483647 });
  });

  it.each([[63], [999], [4]])("voucherCode %s (063 o fuera del catálogo) -> 422 voucherCode sin acceso al período", async (voucherCode) => {
    const res = await post(jbody({ ...valid, voucherCode }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("voucherCode");
    expect(db.period.findUnique).not.toHaveBeenCalled();
    expectNoWrite();
  });
});

describe("POST /api/invoices — autorización y errores", () => {
  it("201: crea con organizationId directo, recalcula IVA/total, autoría y AuditLog", async () => {
    const res = await post(jbody({ ...valid, vatAmount: "999999.99", totalAmount: "0.01" }));
    expect(res.status).toBe(201);
    const dto = await res.json();
    // recalculado server-side, ignora los valores mentirosos del cliente
    expect(dto.vatAmount).toBe("210.00");
    expect(dto.totalAmount).toBe("1210.00");
    for (const k of ["organizationId", "createdById", "updatedById", "clientId"]) expect(dto).not.toHaveProperty(k);

    expect(rec.created.invoice).toMatchObject({
      organizationId: ORG_A,
      periodId: "p_a",
      createdById: SUB_OWNER_A,
      updatedById: SUB_OWNER_A,
    });
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({
      action: "invoice.create",
      targetType: "Invoice",
      metadata: { periodId: "p_a", category: "PURCHASES", voucherCode: 1 },
    });
    // el AuditLog NUNCA lleva importes ni contraparte
    expect(JSON.stringify(rec.audits[0])).not.toMatch(/1000|210|Proveedor|30-99999999|30999999995/);
  });

  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("%s puede crear", async (_r, sub) => {
    H.claims.value = claimsFor(sub);
    expect((await post(jbody(valid))).status).toBe(201);
  });

  it("CUIT con espacios se normaliza; dígito verificador inválido -> 422 counterpartyDocNumber sin escritura", async () => {
    const ok = await post(jbody({ ...valid, counterparty: { ...RI_CUIT, docNumber: "30 99999999 5" } }));
    expect(ok.status).toBe(201);
    expect(rec.created.invoice.counterpartyDocNumber).toBe("30999999995");
    expect(rec.created.invoice.entityCuit).toBe("30-99999999-5");

    setWorld();
    rec.created = {};
    rec.audits.length = 0;
    db.invoice.create.mockClear();
    const bad = await post(jbody({ ...valid, counterparty: { ...RI_CUIT, docNumber: "30-99999999-1" } }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).field).toBe("counterpartyDocNumber");
    expectNoWrite();
  });

  it("periodId de otra organización -> 404 NOT_FOUND antes de leer el cliente, sin escritura", async () => {
    const res = await post(jbody({ ...valid, periodId: "p_b" }));
    expect(res.status).toBe(404);
    expect(db.client.findFirst).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("periodId inexistente -> 404 NOT_FOUND", async () => {
    expect((await post(jbody({ ...valid, periodId: "p_zzz" }))).status).toBe(404);
    expect(db.client.findFirst).not.toHaveBeenCalled();
  });

  it("decimales inválidos -> 422 con field", async () => {
    const res = await post(jbody({ ...valid, netAmount: "1.234" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("netAmount");
  });

  it("sin sesión + body malformado -> 401 (no 400)", async () => {
    H.claims.value = null;
    expect((await post("{")).status).toBe(401);
  });
  it("sin Profile + body malformado -> 403 NO_PROFILE (no 400)", async () => {
    H.claims.value = claimsFor(SUB_NO_PROFILE);
    expect((await (await post("{")).json()).error.code).toBe("NO_PROFILE");
  });
  it("VIEWER + body malformado -> 403 FORBIDDEN (no 400)", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    expect((await post("{")).status).toBe(403);
  });

  it("VIEWER con body válido (también T) -> 403, no crea ni bloquea", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    turivaIncluded(true);
    expect((await post(jbody(valid))).status).toBe(403);
    expect((await post(jbody(saleT))).status).toBe(403);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("si el AuditLog falla -> 500 y rollback", async () => {
    rec.failAudit = true;
    expect((await post(jbody(valid))).status).toBe(500);
    expect(rec.created.invoice).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  });

  it("error de base inesperado al crear -> 500, nunca éxito ni AuditLog", async () => {
    db.invoice.create.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("check constraint", { code: "P2004", clientVersion: "6.19.3" });
    });
    const res = await post(jbody(valid));
    expect(res.status).toBe(500);
    expect(rec.audits).toHaveLength(0);
  });
});

describe("POST /api/invoices — seguridad: autoridad del servidor", () => {
  it("clientId / organizationId / condición del cliente / lidSection / source / clase del body se IGNORAN", async () => {
    const res = await post(
      jbody({
        ...valid,
        clientId: "c_b",
        organizationId: ORG_B,
        clientCondition: 6,
        clientVatConditionCode: 6,
        lidSection: "TURIVA",
        source: "IMPORT",
        legalClass: "M",
        mandatoryLegend: "X",
        partialValidation: true,
      }),
    );
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(rec.created.invoice).toMatchObject({ clientId: "c_a", organizationId: ORG_A, lidSection: "GENERAL", source: "MANUAL" });
    expect(dto).toMatchObject({ legalClass: "A", mandatoryLegend: null, partialValidation: false });
  });

  it("la condición del cliente sale de la base: un Monotributo no emite A aunque el body diga RI", async () => {
    clientCondition("Monotributo");
    const res = await post(jbody({ ...sale, clientCondition: "Responsable Inscripto", clientVatConditionCode: 1 }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("voucherCode");
    expect(db.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c_a", organizationId: ORG_A }, select: { condition: true } }),
    );
    expectNoWrite();
  });

  it("un RI no emite C aunque el body diga Monotributo", async () => {
    const res = await post(
      jbody({ ...sale, voucherCode: 11, voucherVariant: null, clientCondition: "Monotributo", counterparty: { ...RI_CUIT, vatConditionCode: 6 } }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("voucherCode");
  });

  it("condición guardada fuera de las tres etiquetas -> 422 clientCondition, sin escritura", async () => {
    clientCondition("Consumidor Final");
    const res = await post(jbody(valid));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("clientCondition");
    expectNoWrite();
  });
});

describe("POST /api/invoices — matriz normativa (201)", () => {
  it("A venta RI -> RI sin variante: GENERAL, clase A, sin leyenda, validación completa", async () => {
    const res = await post(jbody(sale));
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto).toMatchObject({
      voucherCode: 1,
      lidSection: "GENERAL",
      voucherVariant: "NONE",
      counterpartyVatConditionCode: 1,
      turivaRelationCode: null,
      legalClass: "A",
      mandatoryLegend: null,
      partialValidation: false,
      requiresTurivaSection: false,
      warnings: [],
    });
  });

  it("A con PAGO EN CBU INFORMADA (desde 01/12/2025): variante persistida", async () => {
    const res = await post(jbody({ ...sale, voucherVariant: "PAGO_EN_CBU_INFORMADA" }));
    expect(res.status).toBe(201);
    expect(rec.created.invoice.voucherVariant).toBe("PAGO_EN_CBU_INFORMADA");
    expect((await res.json()).voucherVariant).toBe("PAGO_EN_CBU_INFORMADA");
  });

  it("B venta RI -> Consumidor Final con DNI: sin variante, línea de IVA, documento sin puntos", async () => {
    const res = await post(jbody({ ...saleB, counterparty: consumer(96, "12.345.678") }));
    expect(res.status).toBe(201);
    const data = rec.created.invoice;
    expect(data).toMatchObject({ voucherCode: 6, voucherVariant: null, counterpartyDocType: 96, counterpartyDocNumber: "12345678" });
    expect(data.vatLines.create).toHaveLength(1);
    // Columna heredada: el número del documento (no es CUIT).
    expect(data.entityCuit).toBe("12345678");
    expect((await res.json()).legalClass).toBe("B");
  });

  it("C venta Monotributo -> Monotributo con CUIT", async () => {
    clientCondition("Monotributo");
    const res = await post(jbody({ ...sale, voucherCode: 11, voucherVariant: null, vatRate: "0", counterparty: { ...RI_CUIT, vatConditionCode: 6 } }));
    expect(res.status).toBe(201);
    expect((await res.json()).legalClass).toBe("C");
  });

  it.each([["Exento"], ["Monotributo"]])("C venta %s -> Responsable Inscripto con CUIT (011, 012, 013)", async (condition) => {
    clientCondition(condition);
    for (const [voucherCode, number] of [[11, 2001], [12, 2002], [13, 2003]]) {
      const res = await post(jbody({ ...sale, voucherCode, number, voucherVariant: null, vatRate: "0" }));
      expect(res.status, String(voucherCode)).toBe(201);
      expect(await res.json()).toMatchObject({ voucherCode, legalClass: "C", partialValidation: false, counterpartyVatConditionCode: 1 });
      expect(rec.created.invoice).toMatchObject({ counterpartyDocType: 80, counterpartyDocNumber: "30999999995" });
    }
    const dni = await post(jbody({ ...sale, voucherCode: 11, number: 2004, voucherVariant: null, vatRate: "0", counterparty: { name: "X", docType: 96, docNumber: "12345678", vatConditionCode: 1 } }));
    expect(dni.status).toBe(422);
    expect((await dni.json()).field).toBe("counterpartyDocType");
  });

  it("M venta RI -> RI desde 01/12/2025: clase jurídica A con leyenda OPERACIÓN SUJETA A RETENCIÓN", async () => {
    const res = await post(jbody({ ...sale, voucherCode: 51, voucherVariant: null }));
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto).toMatchObject({ voucherCode: 51, legalClass: "A", mandatoryLegend: LEGEND_OPERACION_SUJETA_A_RETENCION, voucherVariant: null });
    expect(rec.created.invoice.type).toBe("FACTURAS M");
  });

  it("E venta RI -> Cliente del Exterior con CUIT País: validación parcial", async () => {
    const res = await post(
      jbody({ ...sale, voucherCode: 19, voucherVariant: null, vatRate: "0", counterparty: { name: "Importer Ltd", docType: 80, docNumber: "55000000002", vatConditionCode: 9 } }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ legalClass: "E", partialValidation: true, requiresTurivaSection: false, counterpartyVatConditionCode: 9 });
    expect(rec.created.invoice.counterpartyDocNumber).toBe("55000000002");
  });

  it("compras: A de RI; B de RI a cliente Exento sin líneas de IVA; C de Monotributo", async () => {
    expect((await post(jbody(valid))).status).toBe(201);

    clientCondition("Exento");
    const b = await post(jbody({ ...valid, voucherCode: 6, voucherVariant: null, vatRate: "0" }));
    expect(b.status).toBe(201);
    expect(rec.created.invoice.vatLines.create).toHaveLength(0);

    setWorld();
    const c = await post(jbody({ ...valid, voucherCode: 11, voucherVariant: null, vatRate: "0", counterparty: { ...RI_CUIT, vatConditionCode: 6 } }));
    expect(c.status).toBe(201);
    expect((await c.json()).legalClass).toBe("C");
  });
});

describe("POST /api/invoices — matriz normativa (rechazos)", () => {
  it("combinación PENDING (venta B a Cliente del Exterior) -> 422 voucherCode con pending: true", async () => {
    const res = await post(jbody({ ...sale, voucherCode: 6, voucherVariant: null, counterparty: { ...RI_CUIT, vatConditionCode: 9 } }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ field: "voucherCode", pending: true });
    expectNoWrite();
  });

  it("combinación PENDING (compra C de un sujeto IVA No Alcanzado) -> 422 pending: true", async () => {
    const res = await post(jbody({ ...valid, voucherCode: 11, voucherVariant: null, vatRate: "0", counterparty: { ...RI_CUIT, vatConditionCode: 15 } }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ field: "voucherCode", pending: true });
  });

  it("combinación no admitida (no pendiente) -> 422 sin la clave pending", async () => {
    const res = await post(jbody({ ...sale, voucherCode: 11, voucherVariant: null }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("voucherCode");
    expect(json).not.toHaveProperty("pending");
  });

  it("variante CBU en una fecha sin respaldo (compra de 06/2020) -> 422 voucherVariant", async () => {
    const res = await post(jbody({ ...valid, date: "2020-06-10", voucherVariant: "PAGO_EN_CBU_INFORMADA" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("voucherVariant");
    expectNoWrite();
  });

  it("001–003 sin variante -> 422 voucherVariant; variante en otro código -> 422 voucherVariant", async () => {
    expect((await (await post(jbody({ ...sale, voucherVariant: null }))).json()).field).toBe("voucherVariant");
    expect((await (await post(jbody({ ...saleB, voucherVariant: "NONE" }))).json()).field).toBe("voucherVariant");
    expectNoWrite();
  });

  it("OPERACION_SUJETA_A_RETENCION no es una variante almacenable -> 422 voucherVariant", async () => {
    const res = await post(jbody({ ...sale, voucherVariant: "OPERACION_SUJETA_A_RETENCION" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("voucherVariant");
    expect(db.period.findUnique).not.toHaveBeenCalled();
  });

  it("relación TurIVA en un código no T -> 422 turivaRelationCode", async () => {
    const res = await post(jbody({ ...sale, turivaRelationCode: "0001" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("turivaRelationCode");
    expectNoWrite();
  });
});

describe("POST /api/invoices — documento de la contraparte", () => {
  it("condiciones categorizadas se identifican con CUIT: RI -> Monotributo con DNI -> 422 counterpartyDocType", async () => {
    const ok = await post(jbody({ ...sale, counterparty: { ...RI_CUIT, vatConditionCode: 6 } }));
    expect(ok.status).toBe(201);
    const bad = await post(jbody({ ...sale, number: 1002, counterparty: { name: "X", docType: 96, docNumber: "12345678", vatConditionCode: 6 } }));
    expect(bad.status).toBe(422);
    const json = await bad.json();
    expect(json.field).toBe("counterpartyDocType");
    expect(json).not.toHaveProperty("pending");
  });

  it.each([
    ["96 DNI", 96, "12345678", "12345678"],
    ["86 CUIL", 86, withCheckDigit("2012345678"), withCheckDigit("2012345678")],
    ["91 CI extranjera", 91, "abc123", "ABC123"],
    ["94 pasaporte", 94, "x9876543", "X9876543"],
    ["80 CUIT", 80, "30-99999999-5", "30999999995"],
  ])("consumidor final con %s -> 201", async (_l, docType, docNumber, stored) => {
    const res = await post(jbody({ ...saleB, counterparty: consumer(docType, docNumber) }));
    expect(res.status).toBe(201);
    expect(rec.created.invoice).toMatchObject({ counterpartyDocType: docType, counterpartyDocNumber: stored });
  });

  it("99 Sin identificar -> 422 counterpartyDocType con pending: true", async () => {
    const res = await post(jbody({ ...saleB, counterparty: consumer(99, "0") }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ field: "counterpartyDocType", pending: true });
    expectNoWrite();
  });

  it("87 CDI (fuera del catálogo incorporado) -> 422 counterpartyDocType", async () => {
    const res = await post(jbody({ ...saleB, counterparty: consumer(87, "20123456786") }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("counterpartyDocType");
    expectNoWrite();
  });

  it("exportación con documento distinto de CUIT País (clave fiscal extranjera) -> 422 pending: true", async () => {
    const res = await post(
      jbody({ ...sale, voucherCode: 19, voucherVariant: null, vatRate: "0", counterparty: { name: "Importer", docType: 91, docNumber: "TAX123", vatConditionCode: 9 } }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ field: "counterpartyDocType", pending: true });
  });

  it("CUIT País: exige 11 dígitos numéricos (sin separadores) -> 422 counterpartyDocNumber", async () => {
    for (const docNumber of ["55-00000000-2", "5500000000", "550000000021"]) {
      const res = await post(
        jbody({ ...sale, voucherCode: 19, voucherVariant: null, vatRate: "0", counterparty: { name: "Importer", docType: 80, docNumber, vatConditionCode: 9 } }),
      );
      expect(res.status, docNumber).toBe(422);
      expect((await res.json()).field).toBe("counterpartyDocNumber");
    }
    expectNoWrite();
  });

  it("compras: documento no admitido para el emisor (DNI de un RI) -> 422 counterpartyDocType", async () => {
    const res = await post(jbody({ ...valid, counterparty: { name: "X", docType: 96, docNumber: "12345678", vatConditionCode: 1 } }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("counterpartyDocType");
    expectNoWrite();
  });
});

describe("POST /api/invoices — TurIVA (195–197)", () => {
  it("período SIN inclusión TurIVA (sin fila) -> 422, sin comprobante ni AuditLog", async () => {
    const res = await post(jbody(saleT));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("turivaRelationCode");
    expect(json.error.message).toBe(TURIVA_NOT_INCLUDED_MESSAGE);
    expect(rec.locks).toHaveLength(1);
    expectNoWrite();
    expect(world.vatSettings).toBeUndefined(); // nunca se activa automáticamente
  });

  it("período con turivaIncluded false -> 422 y la configuración no cambia", async () => {
    turivaIncluded(false);
    const res = await post(jbody(saleT));
    expect(res.status).toBe(422);
    expect(world.vatSettings?.[0].turivaIncluded).toBe(false);
    expect(db.periodVatSettings.create).not.toHaveBeenCalled();
    expect(db.periodVatSettings.update).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("período incluido -> 201: lock ANTES de la lectura y de la escritura, pestaña TURIVA, validación parcial", async () => {
    turivaIncluded(true);
    const res = await post(jbody(saleT));
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto).toMatchObject({
      voucherCode: 195,
      lidSection: "TURIVA",
      turivaRelationCode: "0001",
      counterpartyVatConditionCode: 5,
      voucherVariant: null,
      legalClass: "T",
      mandatoryLegend: null,
      partialValidation: true,
      requiresTurivaSection: true,
    });
    expect(rec.created.invoice).toMatchObject({
      lidSection: "TURIVA",
      turivaRelationCode: "0001",
      counterpartyDocType: 94,
      counterpartyDocNumber: "AB123456",
      type: "FC T",
    });

    expect(rec.locks).toHaveLength(1);
    expect(rec.locks[0].values).toEqual(["p_a", ORG_A]);
    expect(rec.locks[0].sql).toMatch(/FOR UPDATE/);
    const lockAt = db.$queryRaw.mock.invocationCallOrder[0];
    expect(lockAt).toBeLessThan(db.periodVatSettings.findUnique.mock.invocationCallOrder[0]);
    expect(db.periodVatSettings.findUnique.mock.invocationCallOrder[0]).toBeLessThan(db.invoice.create.mock.invocationCallOrder[0]);
    expect(db.periodVatSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { periodId_organizationId: { periodId: "p_a", organizationId: ORG_A } } }),
    );
    // Lock, lectura, comprobante y AuditLog en UNA transacción.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0].metadata).toMatchObject({ voucherCode: 195 });
  });

  it("compra T de RI a cliente RI (0002) -> 201 TURIVA", async () => {
    turivaIncluded(true);
    const res = await post(jbody({ ...valid, voucherCode: 195, voucherVariant: null, turivaRelationCode: "0002" }));
    expect(res.status).toBe(201);
    expect(rec.created.invoice.lidSection).toBe("TURIVA");
  });

  it("si el AuditLog falla en un T -> 500 y rollback", async () => {
    turivaIncluded(true);
    rec.failAudit = true;
    expect((await post(jbody(saleT))).status).toBe(500);
    expect(rec.created.invoice).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  });

  it("relación incompatible con emisor/receptor (0002 a Consumidor Final) -> 422 turivaRelationCode", async () => {
    turivaIncluded(true);
    const res = await post(jbody({ ...saleT, turivaRelationCode: "0002" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("turivaRelationCode");
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("relación ausente o fuera de 0001–0006 -> 422 turivaRelationCode", async () => {
    turivaIncluded(true);
    for (const turivaRelationCode of [null, "0007", "1"]) {
      const res = await post(jbody({ ...saleT, turivaRelationCode }));
      expect(res.status).toBe(422);
      expect((await res.json()).field).toBe("turivaRelationCode");
    }
    expectNoWrite();
  });

  it("documento incompatible (CUIT a Consumidor Final no residente) -> 422 counterpartyDocType", async () => {
    turivaIncluded(true);
    const res = await post(jbody({ ...saleT, counterparty: { ...saleT.counterparty, docType: 80, docNumber: "30-99999999-5" } }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("counterpartyDocType");
    expectNoWrite();
  });

  it("fecha anterior al 01/04/2017 (compra T de 31/03/2017) -> 422 date", async () => {
    turivaIncluded(true);
    const res = await post(jbody({ ...valid, date: "2017-03-31", voucherCode: 195, voucherVariant: null, turivaRelationCode: "0002" }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("date");
    expect(json.error.message).toMatch(/01\/04\/2017/);
    expectNoWrite();
  });

  it("payload que intenta imponer GENERAL en un T se ignora: se guarda TURIVA", async () => {
    turivaIncluded(true);
    const res = await post(jbody({ ...saleT, lidSection: "GENERAL", requiresTurivaSection: false }));
    expect(res.status).toBe(201);
    expect(rec.created.invoice.lidSection).toBe("TURIVA");
    expect((await res.json()).requiresTurivaSection).toBe(true);
  });

  it("códigos no T: bloquean el período pero no leen TurIVA aunque el período no esté incluido", async () => {
    expect((await post(jbody(sale))).status).toBe(201);
    expect(rec.locks).toHaveLength(1);
    expect(db.periodVatSettings.findUnique).not.toHaveBeenCalled();
    expect(rec.created.invoice.lidSection).toBe("GENERAL");
  });
});

describe("POST /api/invoices — bloqueo del período (lockPeriodForWrite)", () => {
  /** Ejecuta `fn` justo cuando la ruta bloquea el Period (simula una escritura concurrente ya confirmada). */
  const onPeriodLock = (fn: () => void) => {
    const base = db.$queryRaw.getMockImplementation()!;
    let done = false;
    db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!done && /FROM "Period"/.test(strings.join("?"))) {
        done = true;
        fn();
      }
      return base(strings, ...values);
    });
  };
  const periodLocks = () => rec.locks.filter((l) => /FROM "Period"/.test(l.sql));

  it.each([
    ["venta A", sale],
    ["compra A", valid],
    ["venta B", saleB],
  ])("%s (no T) -> un único bloqueo de Period, primera operación de la transacción, antes del comprobante y del AuditLog", async (_l, body) => {
    expect((await post(jbody(body))).status).toBe(201);
    expect(rec.locks).toHaveLength(1);
    expect(rec.locks[0].sql).toMatch(/FOR UPDATE/);
    expect(rec.locks[0].sql).toMatch(/FROM "Period"/);
    expect(rec.locks[0].values).toEqual(["p_a", ORG_A]);
    const lockAt = db.$queryRaw.mock.invocationCallOrder[0];
    expect(lockAt).toBeGreaterThan(db.$transaction.mock.invocationCallOrder[0]);
    expect(lockAt).toBeLessThan(db.invoice.create.mock.invocationCallOrder[0]);
    expect(rec.audits).toHaveLength(1);
  });

  it("T -> un único bloqueo de Period (el helper TurIVA no vuelve a bloquear), antes de la lectura TurIVA", async () => {
    turivaIncluded(true);
    expect((await post(jbody(saleT))).status).toBe(201);
    expect(periodLocks()).toHaveLength(1);
    expect(rec.locks).toHaveLength(1);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.periodVatSettings.findUnique.mock.invocationCallOrder[0]);
  });

  it("nunca bloquea Invoice en un alta", async () => {
    turivaIncluded(true);
    await post(jbody(sale));
    await post(jbody({ ...saleT, number: 2001 }));
    expect(rec.locks.some((l) => /FROM "Invoice"/.test(l.sql))).toBe(false);
  });

  it.each([
    ["no T", () => sale],
    ["T", () => (turivaIncluded(true), saleT)],
  ])("período eliminado en paralelo (%s): el bloqueo no lo encuentra -> 404 NOT_FOUND, sin comprobante ni AuditLog", async (_l, bodyOf) => {
    const body = bodyOf();
    onPeriodLock(() => world.periods.splice(world.periods.findIndex((p) => p.id === "p_a"), 1));
    const res = await post(jbody(body));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(periodLocks()).toHaveLength(1);
    expect(db.periodVatSettings.findUnique).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("rechazos previos a la transacción (422 fecha, 409 duplicado) no bloquean", async () => {
    expect((await post(jbody({ ...sale, date: "2026-06-01" }))).status).toBe(422);
    setWorld((w) => {
      w.invoices = [
        {
          id: "inv_dup",
          organizationId: ORG_A,
          clientId: "c_a",
          periodId: "p_a",
          category: "SALES",
          voucherCode: 1,
          pointOfSale: 1,
          number: 1001,
          counterpartyDocType: 80,
          counterpartyDocNumber: "30999999995",
        },
      ];
    });
    const dup = await post(jbody(sale));
    expect(dup.status).toBe(409);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/invoices — persistencia: modelo contable y columnas heredadas", () => {
  it("escribe el modelo (positivo, código oficial, clientId del período), UNA línea de IVA y las tres columnas nuevas", async () => {
    const res = await post(jbody(valid));
    expect(res.status).toBe(201);
    const data = rec.created.invoice;
    expect(data).toMatchObject({
      clientId: "c_a", // del período autorizado, nunca del body
      source: "MANUAL",
      voucherCode: 1,
      counterpartyDocType: 80,
      counterpartyDocNumber: "30999999995",
      counterpartyName: "Proveedor SA",
      currencyCode: "PES",
      counterpartyVatConditionCode: 1,
      turivaRelationCode: null,
      voucherVariant: "NONE",
    });
    // Columnas heredadas equivalentes a las del contrato anterior.
    expect(data).toMatchObject({ type: "FC A", entityName: "Proveedor SA", entityCuit: "30-99999999-5", pointOfSale: 1, number: 1001 });
    expect(data.date.toISOString()).toBe("2026-05-10T00:00:00.000Z");
    expect(str(data.netAmount)).toBe("1000.00");
    expect(str(data.vatAmount)).toBe("210.00");
    expect(str(data.totalAmount)).toBe("1210.00");
    expect(str(data.vatRate)).toBe("21.00");
    expect(str(data.exchangeRate)).toBe("1.00");
    expect(str(data.taxedNetAmount)).toBe("1000.00");
    expect(str(data.totalVatAmount)).toBe("210.00");
    expect(str(data.directComputableVatCreditAmount)).toBe("210.00"); // compras: = IVA (DIRECT_COMPUTABLE)
    expect(data.reportedComputableVatCreditAmount).toBeNull(); // sólo importación
    expect(str(data.turivaRefundAmount)).toBe("0.00");
    expect(data.lidSection).toBe("GENERAL");
    expect(data.grossIncomeTaxBaseAmount).toBeNull(); // sólo ventas
    expect(str(data.voucherTotalAmount)).toBe("1210.00");
    expect(data.vatLines.create).toHaveLength(1);
    expect(data.vatLines.create[0].vatRateCode).toBe(5); // 21 % -> 0005
    expect(str(data.vatLines.create[0].netAmount)).toBe("1000.00");
    expect(str(data.vatLines.create[0].vatAmount)).toBe("210.00");
    expect(data.vatLines.create[0].creditAllocation).toBe("DIRECT_COMPUTABLE");
    expect(str(data.vatLines.create[0].computableVatAmount)).toBe("210.00");
    expect(data.vatLines.create[0].computableOverridden).toBe(false);
  });

  it("ventas: base IIBB = neto (preserva el criterio anterior) y crédito computable 0", async () => {
    await post(jbody(sale));
    const data = rec.created.invoice;
    expect(str(data.grossIncomeTaxBaseAmount)).toBe("1000.00");
    expect(str(data.directComputableVatCreditAmount)).toBe("0.00");
    expect(data.vatLines.create[0].creditAllocation).toBe("NOT_APPLICABLE");
    expect(data.vatLines.create[0].computableVatAmount).toBeNull();
  });

  it.each([
    ["negativo", "-1000"],
    ["positivo", "1000"],
  ])("NC A con neto %s: modelo POSITIVO y columnas heredadas NEGATIVAS", async (_l, net) => {
    const res = await post(jbody({ ...sale, voucherCode: 3, netAmount: net }));
    expect(res.status).toBe(201);
    const data = rec.created.invoice;
    expect(data.voucherCode).toBe(3);
    expect(data.type).toBe("NC A");
    expect(str(data.taxedNetAmount)).toBe("1000.00");
    expect(str(data.voucherTotalAmount)).toBe("1210.00");
    expect(str(data.netAmount)).toBe("-1000.00");
    expect(str(data.vatAmount)).toBe("-210.00");
    expect(str(data.totalAmount)).toBe("-1210.00");
  });

  it("factura con neto negativo -> 422 netAmount, sin escritura", async () => {
    const res = await post(jbody({ ...valid, netAmount: "-1000" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("netAmount");
    expectNoWrite();
  });

  it("compra B (cliente Exento) con alícuota 0: CERO líneas y el neto va a netWithoutVatBreakdownAmount", async () => {
    clientCondition("Exento");
    const res = await post(jbody({ ...valid, voucherCode: 6, voucherVariant: null, vatRate: "0" }));
    expect(res.status).toBe(201);
    const data = rec.created.invoice;
    expect(data.voucherCode).toBe(6);
    expect(data.vatLines.create).toHaveLength(0);
    expect(str(data.netWithoutVatBreakdownAmount)).toBe("1000.00");
    expect(str(data.taxedNetAmount)).toBe("0.00");
    expect(str(data.totalVatAmount)).toBe("0.00");
    expect(str(data.directComputableVatCreditAmount)).toBe("0.00");
    // no se clasifica automáticamente como exento ni no gravado
    expect(str(data.exemptAmount)).toBe("0.00");
    expect(str(data.nonTaxedAmount)).toBe("0.00");
  });

  it.each([
    ["B (cliente Exento)", 6, 1, "Exento"],
    ["C (emisor Monotributo)", 11, 6, "Responsable Inscripto"],
  ])("compra %s con alícuota > 0 -> 422 vatRate (no discrimina IVA)", async (_l, voucherCode, issuer, condition) => {
    clientCondition(condition);
    const res = await post(jbody({ ...valid, voucherCode, voucherVariant: null, vatRate: "21", counterparty: { ...RI_CUIT, vatConditionCode: issuer } }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.field).toBe("vatRate");
    expect(body.error.message).toMatch(/no discriminan IVA/);
    expectNoWrite();
  });

  it("venta B con alícuota 21: SÍ lleva línea (la regla B/C es sólo de compras)", async () => {
    await post(jbody(saleB));
    expect(rec.created.invoice.vatLines.create).toHaveLength(1);
  });

  it("alícuota fuera de la tabla oficial (p. ej. 1 %) -> 422 vatRate", async () => {
    const res = await post(jbody({ ...valid, vatRate: "1" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("vatRate");
  });

  it("IVA calculado fuera de rango NUMERIC(18,2) -> 422 vatAmount/totalAmount, nunca 500", async () => {
    const res = await post(jbody({ ...valid, netAmount: "9999999999999999.99", vatRate: "27" }));
    expect(res.status).toBe(422);
    expect(["vatAmount", "totalAmount"]).toContain((await res.json()).field);
    expectNoWrite();
  });

  it("duplicado (índice único parcial, P2002) -> 409 CONFLICT sin AuditLog", async () => {
    db.invoice.create.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { target: "Invoice_purchases_voucher_key" },
      });
    });
    const res = await post(jbody(valid));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(rec.audits).toHaveLength(0);
  });
});

describe("POST /api/invoices — fecha frente al período", () => {
  // Período p_a = 05/2026 (makeWorld).
  it("venta dentro del período -> 201 con warnings vacío", async () => {
    const res = await post(jbody({ ...sale, date: "2026-05-31" }));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toEqual([]);
  });

  it.each([["2026-04-30"], ["2026-06-01"]])("venta con fecha %s fuera del período -> 422 date, sin escritura", async (date) => {
    const res = await post(jbody({ ...sale, date }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.field).toBe("date");
    expect(body.error.message).toBe("la fecha de una venta debe pertenecer al período 05/2026");
    expectNoWrite();
  });

  it("compra posterior al último día del período -> 422 date, sin escritura", async () => {
    const res = await post(jbody({ ...valid, date: "2026-06-01" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("date");
    expectNoWrite();
  });

  it("compra de un período anterior -> 201 con advertencia PURCHASE_PRIOR_PERIOD", async () => {
    const res = await post(jbody({ ...valid, date: "2026-04-15" }));
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto.warnings).toEqual([
      {
        code: "PURCHASE_PRIOR_PERIOD",
        message: "El comprobante es de 04/2026, anterior al período 05/2026; se registra en 05/2026.",
      },
    ]);
    expect(rec.created.invoice.periodId).toBe("p_a");
  });

  it("compra antigua (1999-12-31) -> 201 con PURCHASE_PRIOR_PERIOD: sin fecha mínima global", async () => {
    const res = await post(jbody({ ...valid, date: "1999-12-31" }));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings).toEqual([
      {
        code: "PURCHASE_PRIOR_PERIOD",
        message: "El comprobante es de 12/1999, anterior al período 05/2026; se registra en 05/2026.",
      },
    ]);
    expect(rec.created.invoice.voucherDate.toISOString()).toBe("1999-12-31T00:00:00.000Z");
    expect(rec.created.invoice.date.toISOString()).toBe("1999-12-31T00:00:00.000Z");
  });

  it("venta con 1999-12-31 -> 422 por estar fuera del período (no por una fecha mínima)", async () => {
    const res = await post(jbody({ ...sale, date: "1999-12-31" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.field).toBe("date");
    expect(body.error.message).toBe("la fecha de una venta debe pertenecer al período 05/2026");
    expectNoWrite();
  });

  it.each([
    ["2026-02-30"],
    ["2025-02-29"],
    ["2026-05-31T23:30:00-03:00"],
    ["2026-5-3"],
    ["May 31 2026"],
    ["31/12/1999"],
  ])("fecha %s rechazada por el parser -> 422 date, sin comprobante ni AuditLog", async (date) => {
    for (const body of [sale, valid]) {
      const res = await post(jbody({ ...body, date }));
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.field).toBe("date");
      expect(json.error.message).toBe("fecha inválida: debe ser AAAA-MM-DD y existir en el calendario");
    }
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("29/02 de un año bisiesto: compra anterior aceptada y guardada en medianoche UTC del mismo día", async () => {
    const res = await post(jbody({ ...valid, date: "2024-02-29" }));
    expect(res.status).toBe(201);
    expect((await res.json()).warnings[0].code).toBe("PURCHASE_PRIOR_PERIOD");
    expect(rec.created.invoice.voucherDate.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("período de otra organización con fecha fuera de período -> 404 (no revela el período)", async () => {
    const res = await post(jbody({ ...valid, periodId: "p_b", date: "1999-01-01" }));
    expect(res.status).toBe(404);
  });

  it("la fecha se valida contra el período leído con organizationId", async () => {
    await post(jbody(valid));
    expect(db.period.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p_a", organizationId: ORG_A } }),
    );
  });
});

describe("POST /api/invoices — duplicidad global del cliente", () => {
  // p_a = 05/2026 (destino del alta); p_a_prev = 04/2026 del MISMO cliente.
  const existingSale = {
    id: "inv_prev",
    organizationId: ORG_A,
    clientId: "c_a",
    periodId: "p_a_prev",
    category: "SALES",
    voucherCode: 1,
    pointOfSale: 1,
    number: 1001,
    counterpartyDocType: 80,
    counterpartyDocNumber: "30999999995",
  };
  const existingPurchase = { ...existingSale, id: "inv_prev_c", category: "PURCHASES" };
  const withInvoices = (invoices: unknown[]) =>
    setWorld((w) => {
      w.periods.push(periodRow("p_a_prev", "c_a", ORG_A, { month: 4 }));
      w.invoices = invoices;
    });

  it("venta ya cargada en otro período del cliente -> 409 con el período, sin escritura ni AuditLog", async () => {
    withInvoices([existingSale]);
    const res = await post(jbody(sale));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toBe("El comprobante ya existe en el período 04/2026.");
    // sólo el período: ni ids, ni contraparte, ni importes
    expect(JSON.stringify(body)).not.toMatch(/inv_prev|p_a_prev|30999999995|Proveedor/);
    expectNoWrite();
  });

  it("venta duplicada en el MISMO período -> 409 con ese período", async () => {
    withInvoices([{ ...existingSale, periodId: "p_a" }]);
    const res = await post(jbody(sale));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe("El comprobante ya existe en el período 05/2026.");
  });

  it("ventas: la contraparte NO forma parte de la clave (otro receptor igual es duplicado)", async () => {
    withInvoices([{ ...existingSale, counterpartyDocNumber: "20111111112" }]);
    expect((await post(jbody(sale))).status).toBe(409);
  });

  it("ventas: otro punto de venta, número o tipo -> no es duplicado", async () => {
    withInvoices([existingSale]);
    expect((await post(jbody({ ...sale, pointOfSale: 2 }))).status).toBe(201);
    expect((await post(jbody({ ...sale, number: 1002 }))).status).toBe(201);
    expect((await post(jbody(saleB))).status).toBe(201);
  });

  it("compra del mismo emisor ya cargada en otro período -> 409 con el período", async () => {
    withInvoices([existingPurchase]);
    const res = await post(jbody(valid));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe("El comprobante ya existe en el período 04/2026.");
    expectNoWrite();
  });

  it("compras: mismo número de otro emisor -> no es duplicado", async () => {
    withInvoices([{ ...existingPurchase, counterpartyDocNumber: "20111111112" }]);
    expect((await post(jbody(valid))).status).toBe(201);
  });

  it("compras: la clave usa el documento NORMALIZADO (CUIT con guiones = mismo emisor)", async () => {
    withInvoices([existingPurchase]);
    expect((await post(jbody({ ...valid, counterparty: { ...RI_CUIT, docNumber: "30 99999999 5" } }))).status).toBe(409);
  });

  it("una venta no bloquea una compra con la misma numeración (y viceversa)", async () => {
    withInvoices([existingSale]);
    expect((await post(jbody(valid))).status).toBe(201);
    withInvoices([existingPurchase]);
    expect((await post(jbody(sale))).status).toBe(201);
  });

  it("mismo comprobante de OTRO cliente u OTRA organización -> no es duplicado", async () => {
    withInvoices([
      { ...existingSale, clientId: "c_other" },
      { ...existingSale, id: "inv_b", organizationId: ORG_B, clientId: "c_b", periodId: "p_b" },
    ]);
    expect((await post(jbody(sale))).status).toBe(201);
  });

  it("la búsqueda usa organización + cliente del período autorizado, nunca el body", async () => {
    withInvoices([]);
    await post(jbody({ ...sale, clientId: "c_b", organizationId: ORG_B }));
    expect(db.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_A,
          clientId: "c_a",
          category: "SALES",
          voucherCode: 1,
          pointOfSale: 1,
          number: 1001,
        },
      }),
    );
  });

  it("carrera: P2002 al crear y el duplicado ya es visible -> 409 con el período", async () => {
    withInvoices([]);
    db.invoice.findFirst
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ period: { month: 4, year: 2026 } }));
    db.invoice.create.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { target: "Invoice_sales_voucher_key" },
      });
    });
    const res = await post(jbody(sale));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe("El comprobante ya existe en el período 04/2026.");
    expect(rec.audits).toHaveLength(0);
  });

  it("período de otra organización con comprobante duplicado -> 404, no 409", async () => {
    withInvoices([{ ...existingSale, organizationId: ORG_B, clientId: "c_b", periodId: "p_b" }]);
    expect((await post(jbody({ ...sale, periodId: "p_b" }))).status).toBe(404);
  });
});
