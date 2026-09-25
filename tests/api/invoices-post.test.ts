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
  SUB_VIEWER_A,
  SUB_NO_PROFILE,
  ORG_A,
} from "./_harness";
import { Prisma } from "@prisma/client";
import { POST } from "@/app/api/invoices/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  wireDb(db, makeWorld(), rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

const post = (bodyText: string | undefined) =>
  POST(new Request("http://localhost/api/invoices", { method: "POST", body: bodyText }));
const jbody = (o: unknown) => JSON.stringify(o);
const valid = {
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

describe("POST /api/invoices", () => {
  it("201: crea con organizationId directo, recalcula IVA/total, autoría y AuditLog", async () => {
    const res = await post(jbody({ ...valid, vatAmount: "999999.99", totalAmount: "0.01" }));
    expect(res.status).toBe(201);
    const dto = await res.json();
    // recalculado server-side, ignora los valores mentirosos del cliente
    expect(dto.vatAmount).toBe("210.00");
    expect(dto.totalAmount).toBe("1210.00");
    expect(dto).not.toHaveProperty("organizationId");

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
    expect(JSON.stringify(rec.audits[0])).not.toMatch(/1000|210|Proveedor|30-99999999/);
  });

  it("entityCuit sin separadores se persiste canónico; inválido -> 422 sin escritura", async () => {
    const ok = await post(jbody({ ...valid, entityCuit: "30 99999999 5" }));
    expect(ok.status).toBe(201);
    expect(rec.created.invoice.entityCuit).toBe("30-99999999-5");

    rec.created = {};
    rec.audits.length = 0;
    const bad = await post(jbody({ ...valid, entityCuit: "30-99999999-1" }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).field).toBe("entityCuit");
    expect(rec.created.invoice).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  });

  it("periodId de otra organización -> 404 NOT_FOUND, sin escritura", async () => {
    const res = await post(jbody({ ...valid, periodId: "p_b" }));
    expect(res.status).toBe(404);
    expect(rec.created.invoice).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  });

  it("periodId inexistente -> 404 NOT_FOUND", async () => {
    expect((await post(jbody({ ...valid, periodId: "p_zzz" }))).status).toBe(404);
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
  it("rol OK + body malformado -> 400 BAD_REQUEST", async () => {
    expect((await (await post("{")).json()).error.code).toBe("BAD_REQUEST");
  });

  it("VIEWER con body válido -> 403, no crea", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    expect((await post(jbody(valid))).status).toBe(403);
    expect(rec.created.invoice).toBeUndefined();
  });

  it("si el AuditLog falla -> 500 y rollback", async () => {
    rec.failAudit = true;
    expect((await post(jbody(valid))).status).toBe(500);
    expect(rec.created.invoice).toBeUndefined();
  });

});

describe("POST /api/invoices — Fase A: modelo contable + columnas heredadas", () => {
  const str = (d: unknown) => (d instanceof Prisma.Decimal ? d.toFixed(2) : d);

  it("escribe el modelo (positivo, código oficial, clientId del período) y UNA línea de IVA", async () => {
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
    });
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

  it("clientId / voucherCode / organizationId del body se IGNORAN", async () => {
    await post(jbody({ ...valid, clientId: "c_b", voucherCode: 3, organizationId: "org_b" }));
    expect(rec.created.invoice).toMatchObject({ clientId: "c_a", voucherCode: 1, organizationId: ORG_A });
  });

  it("ventas: base IIBB = neto (preserva el criterio anterior) y crédito computable 0", async () => {
    await post(jbody({ ...valid, category: "SALES" }));
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
    const res = await post(jbody({ ...valid, category: "SALES", type: "NC A", netAmount: net }));
    expect(res.status).toBe(201);
    const data = rec.created.invoice;
    expect(data.voucherCode).toBe(3);
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
    expect(rec.created.invoice).toBeUndefined();
  });

  it("compra B con alícuota 0: CERO líneas y el neto va a netWithoutVatBreakdownAmount", async () => {
    const res = await post(jbody({ ...valid, type: "FC B", vatRate: "0" }));
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

  it.each([["FC B"], ["FC C"]])("compra %s con alícuota > 0 -> 422 vatRate (no discrimina IVA)", async (type) => {
    const res = await post(jbody({ ...valid, type, vatRate: "21" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.field).toBe("vatRate");
    expect(body.error.message).toMatch(/no discriminan IVA/);
    expect(rec.created.invoice).toBeUndefined();
  });

  it("venta B con alícuota 21: SÍ lleva línea (la regla B/C es sólo de compras)", async () => {
    await post(jbody({ ...valid, category: "SALES", type: "FC B" }));
    expect(rec.created.invoice.vatLines.create).toHaveLength(1);
  });

  it("tipo fuera del catálogo oficial -> 422 type", async () => {
    const res = await post(jbody({ ...valid, type: "FACTURA X" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("type");
  });

  it("alícuota fuera de la tabla oficial (p. ej. 1 %) -> 422 vatRate", async () => {
    const res = await post(jbody({ ...valid, vatRate: "1" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("vatRate");
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
