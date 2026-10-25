import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
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
  periodRow,
  closedPeriodRow,
  PERIOD_UPDATED_AT,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  SUB_OWNER_B,
  ORG_A,
  ORG_B,
} from "../api/_harness";
import ClientDashboard from "@/app/(app)/client/[id]/dashboard/page";
import NewPeriodPage from "@/app/(app)/client/[id]/period/new/page";
import { NewPeriodForm } from "@/app/(app)/client/[id]/period/new/new-period-form";
import PeriodDashboard from "@/app/(app)/client/[id]/period/[periodId]/page";
import { PeriodActions } from "@/app/(app)/client/[id]/period/[periodId]/period-actions";
import { PeriodStatusActions } from "@/app/(app)/client/[id]/period/[periodId]/period-status-actions";
import { TurivaSetting } from "@/app/(app)/client/[id]/period/[periodId]/turiva-setting";
import { AccessNotice } from "@/app/_components/access-notice";
import { periodYearOptions } from "@/lib/period";

let db: ReturnType<typeof freshDbMock>;

beforeEach(() => {
  db = freshDbMock();
  wireDb(
    db,
    makeWorld({
      clients: [clientRow("c_a", ORG_A, { name: "Alfa SA" }), clientRow("c_b", ORG_B)],
      periods: [
        periodRow("p_empty", "c_a", ORG_A, { month: 4, year: 2026 }),
        periodRow("p_inv", "c_a", ORG_A, { month: 5, year: 2026 }),
        closedPeriodRow("p_closed", "c_a", ORG_A, { month: 3, year: 2026 }),
        periodRow("p_b", "c_b", ORG_B),
      ],
      invoices: [],
      taxRecords: [],
    }),
    freshRecorder(),
  );
  // Dashboard del período: p_empty sin movimientos, p_inv con un TaxRecord,
  // p_closed cerrado y sin movimientos.
  db.period.findFirst.mockImplementation(async ({ where }: { where: { id: string; organizationId: string } }) => {
    const base = { month: 4, year: 2026, clientId: "c_a", organizationId: ORG_A, status: "OPEN", updatedAt: new Date(PERIOD_UPDATED_AT) };
    if (where.organizationId !== ORG_A) return null;
    const client = clientRow("c_a", ORG_A);
    if (where.id === "p_empty") return { id: "p_empty", ...base, invoices: [], taxRecords: [], client };
    if (where.id === "p_closed") return { id: "p_closed", ...base, month: 3, status: "CLOSED", invoices: [], taxRecords: [], client };
    if (where.id === "p_inv") {
      const taxRecords = [{ id: "t1", type: "RETENCION IVA", amount: new Prisma.Decimal("1") }];
      return { id: "p_inv", ...base, month: 5, invoices: [], taxRecords, client };
    }
    return null;
  });
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
const noticeOf = (el: any): string | null => (el && el.type === AccessNotice ? el.props.notice : null);
const textOf = (el: any): string =>
  findAll(el, () => true)
    .flatMap((e) => (typeof e.props?.children === "string" ? [e.props.children] : Array.isArray(e.props?.children) ? e.props.children.filter((c: unknown) => typeof c === "string") : []))
    .join(" ");
/* eslint-enable @typescript-eslint/no-explicit-any */

const ROLE_CASES = [
  ["OWNER", SUB_OWNER_A, { create: true, remove: true }],
  ["ADMIN", SUB_ADMIN_A, { create: true, remove: true }],
  ["ACCOUNTANT", SUB_ACCOUNTANT_A, { create: true, remove: false }],
  ["VIEWER", SUB_VIEWER_A, { create: false, remove: false }],
] as const;

describe("detalle del cliente — botón 'Nuevo período' según rol", () => {
  const call = () => ClientDashboard({ params: Promise.resolve({ id: "c_a" }) });

  it.each(ROLE_CASES)("%s -> visible = %o.create", async (_role, sub, perms) => {
    H.claims.value = claimsFor(sub);
    const el = await call();
    const links = findAll(el, (e) => e.props?.href === "/client/c_a/period/new");
    expect(links.length > 0).toBe(perms.create);
  });

  it("muestra el estado REAL de cada período (Abierto / Cerrado, desde la fila) y usa 'Período' con tilde", async () => {
    const el = await call();
    const cells = findAll(el, (e) => e.props?.["data-period-status"] !== undefined);
    expect(cells.map((c) => [c.props["data-period-status"], c.props.children])).toEqual(
      expect.arrayContaining([
        ["OPEN", "Abierto"],
        ["CLOSED", "Cerrado"],
      ]),
    );
    const text = textOf(el);
    expect(text).toMatch(/Períodos fiscales/);
    expect(text).not.toMatch(/Periodo/);
  });
});

describe("app/client/[id]/period/new/page — guarda por rol (ROLES_CREATE)", () => {
  const call = (id: string) => NewPeriodPage({ params: Promise.resolve({ id }) });

  it.each(ROLE_CASES)("%s -> formulario visible = %o.create", async (_role, sub, perms) => {
    H.claims.value = claimsFor(sub);
    const el = await call("c_a");
    if (perms.create) {
      expect(noticeOf(el)).toBeNull();
      expect(el.type).toBe(NewPeriodForm);
      expect(el.props).toMatchObject({ clientId: "c_a", clientName: "Alfa SA" });
    } else {
      expect(noticeOf(el)).toBe("forbidden");
    }
  });

  it("los años del formulario son exactamente los de la regla compartida (descendentes)", async () => {
    const el = await call("c_a");
    expect(el.props.years).toEqual(periodYearOptions());
    expect(el.props.years[0]).toBeGreaterThan(el.props.years[el.props.years.length - 1]);
  });

  it("cliente de otra organización o inexistente -> notFound()", async () => {
    await expect(call("c_b")).rejects.toThrow("NOTFOUND_PAGE");
    await expect(call("c_zzz")).rejects.toThrow("NOTFOUND_PAGE");
    H.claims.value = claimsFor(SUB_OWNER_B);
    await expect(call("c_a")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("sin sesión -> redirect('/login')", async () => {
    H.claims.value = null;
    await expect(call("c_a")).rejects.toThrow("REDIRECT:/login");
  });
});

describe("dashboard del período — acción 'Eliminar período' según rol", () => {
  const call = (periodId: string) => PeriodDashboard({ params: Promise.resolve({ id: "c_a", periodId }) });

  it.each(ROLE_CASES)("%s -> canDelete = %o.remove", async (_role, sub, perms) => {
    H.claims.value = claimsFor(sub);
    const actions = findType(await call("p_empty"), PeriodActions);
    expect(actions.props).toMatchObject({
      clientId: "c_a",
      periodId: "p_empty",
      periodLabel: "04/2026",
      canDelete: perms.remove,
      hasMovements: false,
    });
  });

  it("período con movimientos -> hasMovements = true", async () => {
    const actions = findType(await call("p_inv"), PeriodActions);
    expect(actions.props.hasMovements).toBe(true);
  });

  it.each(ROLE_CASES)("%s con el período CERRADO -> canDelete = false", async (_role, sub) => {
    H.claims.value = claimsFor(sub);
    expect(findType(await call("p_closed"), PeriodActions).props.canDelete).toBe(false);
  });
});

describe("dashboard del período — cerrar / reabrir según estado y rol", () => {
  const call = (periodId: string) => PeriodDashboard({ params: Promise.resolve({ id: "c_a", periodId }) });
  const CASES = [
    ["OWNER", SUB_OWNER_A, { close: true, reopen: true }],
    ["ADMIN", SUB_ADMIN_A, { close: true, reopen: true }],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A, { close: true, reopen: false }],
    ["VIEWER", SUB_VIEWER_A, { close: false, reopen: false }],
  ] as const;

  it.each(CASES)("%s, período ABIERTO -> props exactas (versión = updatedAt ISO)", async (_role, sub, perms) => {
    H.claims.value = claimsFor(sub);
    const el = await call("p_empty");
    expect(findType(el, PeriodStatusActions).props).toEqual({
      periodId: "p_empty",
      periodLabel: "04/2026",
      closed: false,
      updatedAt: PERIOD_UPDATED_AT,
      canClose: perms.close,
      canReopen: perms.reopen,
    });
    expect(textOf(el)).not.toMatch(/Período cerrado/);
  });

  it.each(CASES)("%s, período CERRADO -> closed = true; TurIVA sin edición; aviso de alcance y de IIBB", async (_role, sub, perms) => {
    H.claims.value = claimsFor(sub);
    const el = await call("p_closed");
    expect(findType(el, PeriodStatusActions).props).toMatchObject({ closed: true, canClose: perms.close, canReopen: perms.reopen });
    expect(findType(el, TurivaSetting).props.canEdit).toBe(false);
    const text = textOf(el);
    expect(text).toMatch(/Período cerrado/);
    expect(text).toMatch(/se puede consultar y exportar/);
    expect(text).toMatch(/no congela la liquidación/);
    // Sólo consulta: los accesos dicen "Ver", no "Gestionar".
    const hrefs = findAll(el, (e) => typeof e.props?.href === "string").map((e) => e.props.href);
    expect(hrefs).toEqual(expect.arrayContaining(["/client/c_a/period/p_closed/sales", "/client/c_a/period/p_closed/liquidation"]));
  });

  it("la etiqueta de estado sale de la fila (data-period-status)", async () => {
    const open = findAll(await call("p_empty"), (e) => e.props?.["data-period-status"] !== undefined);
    const closed = findAll(await call("p_closed"), (e) => e.props?.["data-period-status"] !== undefined);
    expect(open.map((e) => e.props.children)).toEqual(["Abierto"]);
    expect(closed.map((e) => e.props.children)).toEqual(["Cerrado"]);
  });
});

describe("fuentes de UI — requisitos", () => {
  const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
  const FILES = [
    "app/(app)/client/[id]/period/new/new-period-form.tsx",
    "app/(app)/client/[id]/period/[periodId]/period-actions.tsx",
    "app/(app)/client/[id]/period/[periodId]/period-status-actions.tsx",
  ];

  it("period-closed-notice.tsx (sin envíos) no usa confirm()/alert()/prompt() y escribe 'período' con tilde", () => {
    const s = src("app/(app)/client/[id]/period/[periodId]/_components/period-closed-notice.tsx");
    expect(s).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\s*\(/);
    expect(s).not.toMatch(/[Pp]eriodo/);
  });

  it.each(FILES)("%s no usa confirm()/alert()/prompt() y escribe 'período' con tilde", (rel) => {
    const s = src(rel);
    expect(s).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\s*\(/);
    expect(s).not.toMatch(/[Pp]eriodo/);
  });

  it.each(FILES)("%s evita dobles envíos (guarda en ref + botón deshabilitado)", (rel) => {
    const s = src(rel);
    expect(s).toMatch(/inFlight\.current/);
    expect(s).toMatch(/disabled=\{(loading|deleting)\}/);
  });

  it("el formulario lee FormData antes de deshabilitar los selects", () => {
    const s = src("app/(app)/client/[id]/period/new/new-period-form.tsx");
    expect(s.indexOf("new FormData")).toBeLessThan(s.indexOf("setLoading(true)"));
  });
});
