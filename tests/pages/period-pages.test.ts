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
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOTFOUND_PAGE");
  },
}));

import {
  freshDbMock,
  freshRecorder,
  wireDb,
  makeWorld,
  claimsFor,
  clientRow,
  periodRow,
  SUB_OWNER_A,
  SUB_OWNER_B,
  SUB_NO_ORG,
  ORG_A,
  ORG_B,
} from "../api/_harness";
import { Prisma } from "@prisma/client";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatMoney } from "@/lib/format";

import PeriodDashboard from "@/app/(app)/client/[id]/period/[periodId]/page";
import PurchasesPage from "@/app/(app)/client/[id]/period/[periodId]/purchases/page";
import SalesPage from "@/app/(app)/client/[id]/period/[periodId]/sales/page";
import TaxesPage from "@/app/(app)/client/[id]/period/[periodId]/taxes/page";
import LiquidationPage from "@/app/(app)/client/[id]/period/[periodId]/liquidation/page";

type PageFn = (a: { params: Promise<{ id: string; periodId: string }> }) => Promise<unknown>;
const PAGES: Array<[string, PageFn]> = [
  ["period", PeriodDashboard as PageFn],
  ["purchases", PurchasesPage as PageFn],
  ["sales", SalesPage as PageFn],
  ["taxes", TaxesPage as PageFn],
  ["liquidation", LiquidationPage as PageFn],
];

let db: ReturnType<typeof freshDbMock>;

beforeEach(() => {
  db = freshDbMock();
  const world = makeWorld({
    clients: [clientRow("c_a", ORG_A), clientRow("c_b", ORG_B)],
    periods: [periodRow("p_a", "c_a", ORG_A), periodRow("p_b", "c_b", ORG_B)],
    invoices: [],
    taxRecords: [],
  });
  wireDb(db, world, freshRecorder());
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNotice = (el: any) => !!el && el.type === AccessNotice;
const call = (page: PageFn, id: string, periodId: string) =>
  page({ params: Promise.resolve({ id, periodId }) });

describe.each(PAGES)("app/client/[id]/period/[periodId]/%s — guardPage + requirePeriodAccess", (_name, page) => {
  it("período propio con [id] correcto -> renderiza (sin AccessNotice)", async () => {
    const el = await call(page, "c_a", "p_a");
    expect(isNotice(el)).toBe(false);
  });

  it("período de otra organización -> notFound()", async () => {
    await expect(call(page, "c_a", "p_b")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("[id] no coincide con period.clientId -> notFound()", async () => {
    await expect(call(page, "c_otro", "p_a")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("período inexistente -> notFound()", async () => {
    await expect(call(page, "c_a", "p_zzz")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("sin sesión -> redirect('/login')", async () => {
    H.claims.value = null;
    await expect(call(page, "c_a", "p_a")).rejects.toThrow("REDIRECT:/login");
  });

  it("OWNER de otra organización -> notFound()", async () => {
    H.claims.value = claimsFor(SUB_OWNER_B);
    await expect(call(page, "c_a", "p_a")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("Profile sin Membership en esa organización -> notFound() (D4: no revela que el período existe)", async () => {
    H.claims.value = claimsFor(SUB_NO_ORG);
    await expect(call(page, "c_a", "p_a")).rejects.toThrow("NOTFOUND_PAGE");
  });
});

describe("consultas scoped por organizationId", () => {
  it("purchases: invoice.findMany filtra por { periodId, organizationId, category }", async () => {
    await call(PurchasesPage as PageFn, "c_a", "p_a");
    expect(db.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { periodId: "p_a", organizationId: ORG_A, category: "PURCHASES" },
      }),
    );
  });

  it("sales: category SALES", async () => {
    await call(SalesPage as PageFn, "c_a", "p_a");
    expect(db.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { periodId: "p_a", organizationId: ORG_A, category: "SALES" },
      }),
    );
  });

  it("taxes: taxRecord.findMany filtra por { periodId, organizationId }", async () => {
    await call(TaxesPage as PageFn, "c_a", "p_a");
    expect(db.taxRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { periodId: "p_a", organizationId: ORG_A } }),
    );
  });

  it("period / liquidation: period.findFirst filtra por { id, organizationId }", async () => {
    await call(PeriodDashboard as PageFn, "c_a", "p_a");
    await call(LiquidationPage as PageFn, "c_a", "p_a");
    for (const c of db.period.findFirst.mock.calls) {
      expect(c[0].where).toEqual({ id: "p_a", organizationId: ORG_A });
    }
  });
});

describe("liquidation — sección IIBB", () => {
  const D = (v: string) => new Prisma.Decimal(v);
  // Venta modelada (Factura A) con base IIBB DISTINTA del neto: 120000 ≠ 150000.
  const sale = {
    category: "SALES",
    netAmount: D("0"),
    vatAmount: D("0"),
    totalAmount: D("0"),
    voucherCode: 1,
    taxedNetAmount: D("150000"),
    netWithoutVatBreakdownAmount: D("0"),
    totalVatAmount: D("31500"),
    directComputableVatCreditAmount: D("0"),
    voucherTotalAmount: D("181500"),
    grossIncomeTaxBaseAmount: D("120000"),
    vatLines: [{ vatAmount: D("31500"), creditAllocation: "NOT_APPLICABLE" }],
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const text = (el: any): string =>
    el == null || typeof el === "boolean" ? "" : typeof el !== "object" ? String(el) : Array.isArray(el) ? el.map(text).join("") : text(el.props?.children);
  /** Filas rótulo/importe: elementos cuyos hijos son exactamente dos <span>. */
  function rows(el: any, out: Array<[string, string]> = []): Array<[string, string]> {
    if (!el || typeof el !== "object") return out;
    if (Array.isArray(el)) {
      for (const c of el) rows(c, out);
      return out;
    }
    const kids = el.props?.children;
    if (Array.isArray(kids) && kids.length === 2 && kids.every((k: any) => k?.type === "span")) out.push([text(kids[0]), text(kids[1])]);
    rows(kids, out);
    return out;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it("'Base Imponible IIBB' muestra iibb.base (no las ventas netas) y no queda el rótulo 'Ventas Netas'", async () => {
    db.period.findFirst.mockImplementation(async ({ where }: { where: { id: string; organizationId: string } }) =>
      where.id === "p_a" && where.organizationId === ORG_A
        ? { ...periodRow("p_a", "c_a", ORG_A), invoices: [sale], taxRecords: [], client: clientRow("c_a", ORG_A), vatSettings: null }
        : null,
    );
    const r = rows(await call(LiquidationPage as PageFn, "c_a", "p_a"));
    const labels = r.map(([l]) => l);

    expect(r).toContainEqual(["Base Imponible IIBB", `$${formatMoney("120000.00")}`]);
    expect(r).toContainEqual(["Impuesto Determinado (3%)", `$${formatMoney("3600.00")}`]);
    expect(labels.indexOf("Impuesto Determinado (3%)")).toBe(labels.indexOf("Base Imponible IIBB") + 1);
    expect(labels).not.toContain("Ventas Netas");
    expect(r.map(([, v]) => v)).not.toContain(`$${formatMoney("150000.00")}`);
  });
});
