import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Prisma } from "@prisma/client";

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
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import {
  freshDbMock,
  freshRecorder,
  wireDb,
  makeWorld,
  claimsFor,
  clientRow,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  ORG_A,
} from "../api/_harness";
import PeriodDashboard from "@/app/(app)/client/[id]/period/[periodId]/page";
import { TurivaSetting } from "@/app/(app)/client/[id]/period/[periodId]/turiva-setting";
import { PeriodActions } from "@/app/(app)/client/[id]/period/[periodId]/period-actions";
import { MISSING_GLOBAL_COEFFICIENT_MESSAGE } from "@/lib/invoice-model";
import { TURIVA_SECTION_ID } from "@/lib/turiva-setting";

const D = (v: string) => new Prisma.Decimal(v);
let db: ReturnType<typeof freshDbMock>;
/** Lo que devuelve period.findFirst (la página incluye vatSettings, invoices, taxRecords, client). */
let found: Record<string, unknown>;

const basePeriod = () => ({
  id: "p_a",
  month: 5,
  year: 2026,
  clientId: "c_a",
  organizationId: ORG_A,
  invoices: [],
  taxRecords: [],
  client: clientRow("c_a", ORG_A),
  vatSettings: null as unknown,
});

beforeEach(() => {
  db = freshDbMock();
  wireDb(db, makeWorld(), freshRecorder());
  found = basePeriod();
  db.period.findFirst.mockImplementation(async ({ where }: { where: { id: string; organizationId: string } }) =>
    where.id === "p_a" && where.organizationId === ORG_A ? found : null,
  );
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function findAll(el: any, pred: (e: any) => boolean, out: any[] = []): any[] {
  if (!el || typeof el !== "object") return out;
  if (Array.isArray(el)) {
    for (const c of el) findAll(c, pred, out);
    return out;
  }
  if (pred(el)) out.push(el);
  findAll(el.props?.children, pred, out);
  return out;
}
const findType = (el: any, type: unknown) => findAll(el, (e) => e.type === type)[0] ?? null;
/* eslint-enable @typescript-eslint/no-explicit-any */

const call = () => PeriodDashboard({ params: Promise.resolve({ id: "c_a", periodId: "p_a" }) });

describe("página del período — tarjeta TurIVA", () => {
  it.each([
    ["OWNER", SUB_OWNER_A, true],
    ["ADMIN", SUB_ADMIN_A, true],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A, true],
    ["VIEWER", SUB_VIEWER_A, false],
  ])("%s -> props exactas { periodId, turivaIncluded, canEdit: %s }", async (_role, sub, canEdit) => {
    H.claims.value = claimsFor(sub);
    const card = findType(await call(), TurivaSetting);
    expect(card.props).toEqual({ periodId: "p_a", turivaIncluded: false, canEdit });
  });

  it("sin PeriodVatSettings -> false; con fila -> su valor (true / false)", async () => {
    expect(findType(await call(), TurivaSetting).props.turivaIncluded).toBe(false);
    found = { ...basePeriod(), vatSettings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: true, organizationId: ORG_A, createdById: "x" } };
    const on = findType(await call(), TurivaSetting);
    expect(on.props).toEqual({ periodId: "p_a", turivaIncluded: true, canEdit: true });
    expect(on.key).toBe("true");
    found = { ...basePeriod(), vatSettings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: false } };
    expect(findType(await call(), TurivaSetting).props.turivaIncluded).toBe(false);
  });

  it("la lectura del período filtra por organizationId (incluye vatSettings)", async () => {
    await call();
    expect(db.period.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p_a", organizationId: ORG_A }, include: expect.objectContaining({ vatSettings: true }) }),
    );
  });

  it("falta el coeficiente global: se ve el MISMO error de liquidación y también la tarjeta TurIVA (sin resultados)", async () => {
    const purchase = {
      category: "PURCHASES",
      netAmount: D("1000"),
      vatAmount: D("0"),
      totalAmount: D("1210"),
      voucherCode: 1,
      taxedNetAmount: D("1000"),
      totalVatAmount: D("210"),
      netWithoutVatBreakdownAmount: D("0"),
      directComputableVatCreditAmount: D("0"),
      voucherTotalAmount: D("1210"),
      vatLines: [{ vatAmount: D("210"), creditAllocation: "GLOBAL_PRORATION" }],
    };
    for (const [sub, canEdit] of [[SUB_OWNER_A, true], [SUB_ADMIN_A, true], [SUB_ACCOUNTANT_A, true], [SUB_VIEWER_A, false]] as const) {
      H.claims.value = claimsFor(sub);
      found = { ...basePeriod(), invoices: [purchase], vatSettings: { creditProrationMode: "GLOBAL", globalCoefficient: null, turivaIncluded: true } };
      const el = await call();
      const alerts = findAll(el, (e) => e.props?.role === "alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].props.children).toBe(MISSING_GLOBAL_COEFFICIENT_MESSAGE);
      expect(findType(el, TurivaSetting).props).toEqual({ periodId: "p_a", turivaIncluded: true, canEdit });
      // Sin resultados de liquidación ni otras secciones.
      expect(findType(el, PeriodActions)).toBeNull();
      expect(JSON.stringify(findAll(el, (e) => typeof e.props?.children === "string").map((e) => e.props.children))).not.toMatch(/Posición IVA|IVA Débito|IVA Crédito/);
    }
  });
});

describe("TurivaSetting — render accesible (sin base real)", () => {
  const html = (turivaIncluded: boolean, canEdit: boolean) =>
    renderToStaticMarkup(createElement(TurivaSetting, { periodId: "p_a", turivaIncluded, canEdit }));

  it("editores: checkbox con label explícito, estado en texto y ayuda asociada; ancla #turiva", () => {
    const h = html(true, true);
    expect(h).toContain(`id="${TURIVA_SECTION_ID}"`);
    expect(h).toMatch(/<input[^>]*id="turiva-included"[^>]*type="checkbox"[^>]*checked=""/);
    expect(h).toContain('for="turiva-included"');
    expect(h).toContain("Incluir operaciones TurIVA (comprobantes 195–197)");
    expect(h).toMatch(/aria-describedby="turiva-help"/);
    expect(h).toContain('id="turiva-help"');
    expect(h).toMatch(/Incluido en el Régimen TurIVA: <strong>Sí<\/strong>/);
    expect(h).toMatch(/aria-busy="false"/);
    expect(html(false, true)).toMatch(/Incluido en el Régimen TurIVA: <strong>No<\/strong>/);
    expect(html(false, true)).not.toMatch(/checked=""/);
  });

  it("VIEWER: sólo el estado en texto, sin checkbox", () => {
    const h = html(true, false);
    expect(h).toMatch(/Incluido en el Régimen TurIVA: <strong>Sí<\/strong>/);
    expect(h).not.toContain("<input");
    expect(h).not.toContain("turiva-included");
  });
});

describe("fuentes de UI del control TurIVA", () => {
  const src = readFileSync(new URL("../../app/(app)/client/[id]/period/[periodId]/turiva-setting.tsx", import.meta.url), "utf8");

  it("cliente, sin confirm/alert/prompt, sin Prisma ni fetch directo, 'período' con tilde", () => {
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\s*\(/);
    expect(src).not.toMatch(/@prisma\/client|@\/lib\/prisma|fetch\(/);
    expect(src).not.toMatch(/[Pp]eriodo/);
  });

  it("evita dobles envíos y no cuenta comprobantes (la API decide el 409)", () => {
    expect(src).toMatch(/inFlight/);
    expect(src).toMatch(/runTurivaToggle\(/);
    expect(src).toMatch(/disabled=\{loading\}/);
    expect(src).not.toMatch(/invoices|voucherCode|\.count\(|\.filter\(/);
  });
});
