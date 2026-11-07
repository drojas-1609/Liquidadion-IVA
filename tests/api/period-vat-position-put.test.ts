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

import { Prisma } from "@prisma/client";
import {
  freshDbMock,
  freshRecorder,
  wireDb,
  makeWorld,
  claimsFor,
  periodRow,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  ORG_A,
  ORG_B,
  type World,
  closePeriodInWorld,
  expectPeriodClosedResponse,
  expectClosedRollback,
  periodLockOrder,
} from "./_harness";
import { PUT } from "@/app/api/periods/[id]/vat-position/route";

/**
 * PUT /api/periods/[id]/vat-position. El harness no tiene base real: prueba
 * autorización, bloqueo del período, reemplazo total y auditoría sin importes.
 */

const D = (v: string) => new Prisma.Decimal(v);
let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  world = makeWorld({
    periods: [periodRow("p_new", "c_a", ORG_A, { month: 1 }), periodRow("p_set", "c_a", ORG_A, { month: 2 }), periodRow("p_b", "c_b", ORG_B)],
    vatSettings: [
      {
        periodId: "p_set",
        organizationId: ORG_A,
        creditProrationMode: "NONE",
        globalCoefficient: null,
        globalCoefficientStatus: null,
        turivaIncluded: true,
        previousTechnicalBalance: D("500.00"),
        previousTechnicalBalanceReference: "DJ 01/2026",
      },
    ],
    vatCreditAdjustments: [
      { periodId: "p_set", organizationId: ORG_A, regime: "LEY_27467_ART_91", contributionsAmount: D("100.00"), computableAmount: D("7.30"), reference: null },
    ],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

function put(id: string, body: unknown) {
  return PUT(
    new Request(`http://localhost/api/periods/${id}/vat-position`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
const annexI = { regime: "LEY_27541_ANEXO_I", contributionsAmount: "684.93", computableAmount: "50.00", reference: "F.931 09/2026" };
const body = { previousTechnicalBalance: "500.00", previousTechnicalBalanceReference: "DJ 08/2026", adjustments: [annexI] };

describe("PUT /api/periods/[id]/vat-position", () => {
  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("%s guarda: crea la configuración del período y el ajuste, con AuditLog sin importes", async (_role, sub) => {
    H.claims.value = claimsFor(sub);
    const res = await put("p_new", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ periodId: "p_new", changed: true });
    // Bloqueo del período antes de leer o escribir.
    expect(rec.locks).toHaveLength(1);
    expect(rec.locks[0].sql.replace(/\s+/g, " ")).toMatch(/FROM "Period" WHERE "id" = \? AND "organizationId" = \? FOR UPDATE\s*$/);
    expect(rec.locks[0].values).toEqual(["p_new", ORG_A]);
    expect(periodLockOrder(db)).toBeLessThan(db.periodVatSettings.findUnique.mock.invocationCallOrder[0]);
    const settings = (world.vatSettings ?? []).find((s) => s.periodId === "p_new");
    expect(settings.previousTechnicalBalance.toFixed(2)).toBe("500.00");
    expect(settings.previousTechnicalBalanceReference).toBe("DJ 08/2026");
    const adj = (world.vatCreditAdjustments ?? []).filter((a) => a.periodId === "p_new");
    expect(adj.map((a) => [a.regime, a.contributionsAmount.toFixed(2), a.computableAmount.toFixed(2), a.reference, a.organizationId])).toEqual([
      ["LEY_27541_ANEXO_I", "684.93", "50.00", "F.931 09/2026", ORG_A],
    ]);
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({ action: "period.vat_position_change", targetType: "Period", targetId: "p_new", organizationId: ORG_A });
    expect(rec.audits[0].metadata).toEqual({
      changedFields: "previousTechnicalBalance,previousTechnicalBalanceReference,adjustment.LEY_27541_ANEXO_I",
      regimesBefore: "",
      regimesAfter: "LEY_27541_ANEXO_I",
    });
    expect(JSON.stringify(rec.audits[0].metadata)).not.toMatch(/684|50\.00|500|F\.931|DJ/);
  });

  it("reemplazo total: el régimen ausente se borra y el presente se actualiza", async () => {
    const res = await put("p_set", { previousTechnicalBalance: "0", adjustments: [annexI] });
    expect(res.status).toBe(200);
    const adj = (world.vatCreditAdjustments ?? []).filter((a) => a.periodId === "p_set");
    expect(adj.map((a) => a.regime)).toEqual(["LEY_27541_ANEXO_I"]);
    const settings = (world.vatSettings ?? []).find((s) => s.periodId === "p_set");
    expect(settings.previousTechnicalBalance.toFixed(2)).toBe("0.00");
    expect(settings.previousTechnicalBalanceReference).toBeNull();
    expect(settings.turivaIncluded).toBe(true); // no toca el resto de la configuración
    expect(rec.audits[0].metadata).toMatchObject({ regimesBefore: "LEY_27467_ART_91", regimesAfter: "LEY_27541_ANEXO_I" });
  });

  it("sin cambios: 200 sin escrituras ni AuditLog", async () => {
    const res = await put("p_set", {
      previousTechnicalBalance: "500",
      previousTechnicalBalanceReference: "DJ 01/2026",
      adjustments: [{ regime: "LEY_27467_ART_91", contributionsAmount: "100", computableAmount: "7.3" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ periodId: "p_set", changed: false });
    expect(db.periodVatSettings.update).not.toHaveBeenCalled();
    expect(db.periodVatCreditAdjustment.upsert).not.toHaveBeenCalled();
    expect(db.periodVatCreditAdjustment.deleteMany).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("VIEWER: 403 sin escrituras", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    const res = await put("p_new", body);
    expect(res.status).toBe(403);
    expect(db.periodVatCreditAdjustment.upsert).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("período de otra organización: 404 sin escrituras", async () => {
    const res = await put("p_b", body);
    expect(res.status).toBe(404);
    expect(db.periodVatCreditAdjustment.upsert).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("período cerrado: 409 y nada se escribe", async () => {
    closePeriodInWorld(world, "p_set");
    const res = await put("p_set", body);
    await expectPeriodClosedResponse(res);
    expectClosedRollback(db, rec);
  });

  it.each([
    [{ ...body, previousTechnicalBalance: "-1" }, "previousTechnicalBalance"],
    [{ ...body, adjustments: [{ ...annexI, computableAmount: "700.00" }] }, "adjustments.0.computableAmount"],
    [{ ...body, adjustments: [{ ...annexI, regime: "DECRETO_814" }] }, "adjustments.0.regime"],
    [{ ...body, adjustments: [annexI, annexI] }, "adjustments.1.regime"],
    [{ ...body, extra: 1 }, "extra"],
  ])("entrada inválida: 422 en %#", async (b, field) => {
    const res = await put("p_new", b);
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe(field);
    expect(rec.audits).toHaveLength(0);
  });
});
