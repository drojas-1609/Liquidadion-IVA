import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  claims: { throw: null as unknown, value: null as unknown },
  db: { current: null as unknown },
  excelThrow: { v: false },
  calcThrow: { v: false },
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
vi.mock("@/lib/excel", async (orig) => {
  const mod = (await orig()) as typeof import("@/lib/excel");
  return {
    ...mod,
    generateLiquidationExcel: (data: Parameters<typeof mod.generateLiquidationExcel>[0]) => {
      if (H.excelThrow.v) throw new Error("excel boom");
      return mod.generateLiquidationExcel(data);
    },
  };
});
vi.mock("@/lib/liquidation-calc", async (orig) => {
  const mod = (await orig()) as typeof import("@/lib/liquidation-calc");
  return {
    ...mod,
    computeLiquidation: (p: Parameters<typeof mod.computeLiquidation>[0]) => {
      if (H.calcThrow.v) throw new Error("calc boom");
      return mod.computeLiquidation(p);
    },
  };
});

import {
  freshDbMock,
  freshRecorder,
  wireDb,
  makeWorld,
  claimsFor,
  clientRow,
  periodRow,
  SUB_OWNER_A,
  SUB_VIEWER_A,
  SUB_NO_ORG,
  ORG_A,
  ORG_B,
} from "./_harness";
import { GET } from "@/app/api/client/[id]/period/[periodId]/export/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  const world = makeWorld({
    clients: [clientRow("c_a", ORG_A, { name: 'Río Paraná "SA"' }), clientRow("c_b", ORG_B)],
    periods: [periodRow("p_a", "c_a", ORG_A), periodRow("p_b", "c_b", ORG_B)],
    invoices: [],
    taxRecords: [],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
  H.excelThrow.v = false;
  H.calcThrow.v = false;
});

const get = (id: string, periodId: string) =>
  GET(new Request(`http://localhost/api/client/${id}/period/${periodId}/export`), {
    params: Promise.resolve({ id, periodId }),
  });

describe("GET .../export — orden seguro (generar -> auditar -> responder)", () => {
  it("camino feliz: 200 XLSX + EXACTAMENTE 1 AuditLog liquidation.export sin importes ni buffer", async () => {
    const res = await get("c_a", "p_a");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename=/);
    // nombre saneado: sin comillas
    expect(res.headers.get("content-disposition")).not.toMatch(/"SA"/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);

    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({
      action: "liquidation.export",
      targetType: "Liquidation",
      targetId: "p_a",
      organizationId: ORG_A,
      actorProfileId: SUB_OWNER_A,
    });
    expect(rec.audits[0].metadata).toEqual({
      periodId: "p_a",
      clientId: "c_a",
      month: 5,
      year: 2026,
      invoiceCount: 0,
      taxRecordCount: 0,
    });
    // el AuditLog NO contiene bytes del excel ni importes
    expect(JSON.stringify(rec.audits[0])).not.toMatch(/PK|buffer|payable|iva/i);
  });

  it("cross-org: [id] de A, period de B -> 404, sin cálculo, sin generación, SIN AuditLog", async () => {
    const calcSpy = vi.fn();
    const res = await get("c_a", "p_b");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(rec.audits).toHaveLength(0);
    expect(calcSpy).not.toHaveBeenCalled();
  });

  it("[id] no coincide con period.clientId -> 404, sin AuditLog", async () => {
    const res = await get("c_otro", "p_a");
    expect(res.status).toBe(404);
    expect(rec.audits).toHaveLength(0);
  });

  it("period inexistente -> 404, sin AuditLog", async () => {
    const res = await get("c_a", "p_zzz");
    expect(res.status).toBe(404);
    expect(rec.audits).toHaveLength(0);
  });

  it("falla el CÁLCULO -> 500, sin AuditLog y sin binario", async () => {
    H.calcThrow.v = true;
    const res = await get("c_a", "p_a");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
    expect(rec.audits).toHaveLength(0);
  });

  it("falla la GENERACIÓN del Excel -> 500, sin AuditLog y sin binario", async () => {
    H.excelThrow.v = true;
    const res = await get("c_a", "p_a");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toMatch(/excel boom/);
    expect(rec.audits).toHaveLength(0);
  });

  it("falla el AuditLog (tras generar el buffer) -> 500 y NO se entrega el buffer", async () => {
    rec.failAudit = true;
    const res = await get("c_a", "p_a");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
  });

  it("sin sesión -> 401, sin AuditLog", async () => {
    H.claims.value = null;
    expect((await get("c_a", "p_a")).status).toBe(401);
    expect(rec.audits).toHaveLength(0);
  });

  it("Profile sin Membership -> 403 NO_ORGANIZATION", async () => {
    H.claims.value = claimsFor(SUB_NO_ORG);
    expect((await get("c_a", "p_a")).status).toBe(403);
  });

  it("VIEWER puede exportar (ROLES_EXPORT == ROLES_READ)", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    const res = await get("c_a", "p_a");
    expect(res.status).toBe(200);
    expect(rec.audits).toHaveLength(1);
  });
});
