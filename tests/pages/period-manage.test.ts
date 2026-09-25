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
        periodRow("p_b", "c_b", ORG_B),
      ],
      invoices: [],
      taxRecords: [],
    }),
    freshRecorder(),
  );
  // Dashboard del período: p_empty sin movimientos, p_inv con un TaxRecord.
  db.period.findFirst.mockImplementation(async ({ where }: { where: { id: string; organizationId: string } }) => {
    const base = { month: 4, year: 2026, clientId: "c_a", organizationId: ORG_A };
    if (where.organizationId !== ORG_A) return null;
    const client = clientRow("c_a", ORG_A);
    if (where.id === "p_empty") return { id: "p_empty", ...base, invoices: [], taxRecords: [], client };
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

  it("no muestra el badge 'Abierto' fijo (no existe estado real) y usa 'Período' con tilde", async () => {
    const el = await call();
    const text = textOf(el);
    expect(text).not.toMatch(/Abierto/);
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
});

describe("fuentes de UI — requisitos", () => {
  const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
  const FILES = [
    "app/(app)/client/[id]/period/new/new-period-form.tsx",
    "app/(app)/client/[id]/period/[periodId]/period-actions.tsx",
  ];

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
