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
  SUB_OWNER_B,
  ORG_A,
  ORG_B,
} from "../api/_harness";
import ClientDashboard from "@/app/(app)/client/[id]/dashboard/page";
import EditClientPage from "@/app/(app)/client/[id]/edit/page";
import { ClientActions } from "@/app/(app)/client/[id]/dashboard/client-actions";
import { EditClientForm } from "@/app/(app)/client/[id]/edit/edit-client-form";
import { AccessNotice } from "@/app/_components/access-notice";

let db: ReturnType<typeof freshDbMock>;

beforeEach(() => {
  db = freshDbMock();
  wireDb(
    db,
    makeWorld({
      clients: [
        clientRow("c_a", ORG_A, { name: "Alfa SA", address: "Calle 1" }),
        clientRow("c_b", ORG_B, { name: "Beta SA" }),
      ],
      periods: [],
    }),
    freshRecorder(),
  );
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Busca en profundidad el primer elemento React de tipo `type`. */
function findElement(el: any, type: unknown): any {
  if (!el || typeof el !== "object") return null;
  if (Array.isArray(el)) {
    for (const child of el) {
      const hit = findElement(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (el.type === type) return el;
  return findElement(el.props?.children, type);
}
const noticeOf = (el: any): string | null => (el && el.type === AccessNotice ? el.props.notice : null);
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("detalle del cliente — acciones de gestión según rol", () => {
  const call = (id: string) => ClientDashboard({ params: Promise.resolve({ id }) });

  it.each([
    ["OWNER", SUB_OWNER_A, true],
    ["ADMIN", SUB_ADMIN_A, true],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A, false],
    ["VIEWER", SUB_VIEWER_A, false],
  ])("%s -> canEdit/canDelete = %s", async (_role, sub, allowed) => {
    H.claims.value = claimsFor(sub);
    const actions = findElement(await call("c_a"), ClientActions);
    expect(actions).not.toBeNull();
    expect(actions.props).toMatchObject({ clientId: "c_a", canEdit: allowed, canDelete: allowed });
  });
});

describe("app/client/[id]/edit/page — sólo OWNER / ADMIN", () => {
  const call = (id: string) => EditClientPage({ params: Promise.resolve({ id }) });

  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
  ])("%s -> formulario precargado, consulta acotada a la organización", async (_role, sub) => {
    H.claims.value = claimsFor(sub);
    const el = await call("c_a");
    expect(noticeOf(el)).toBeNull();
    const form = findElement(el, EditClientForm);
    expect(form.props.client).toMatchObject({
      id: "c_a",
      name: "Alfa SA",
      condition: "Responsable Inscripto",
      address: "Calle 1",
      defaultIibbRate: "3",
    });
    expect(form.props.client).not.toHaveProperty("organizationId");
    expect(db.client.findFirst).toHaveBeenCalledWith({ where: { id: "c_a", organizationId: ORG_A } });
  });

  it.each([
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
    ["VIEWER", SUB_VIEWER_A],
  ])("%s -> <AccessNotice notice='forbidden'> sin datos del cliente", async (_role, sub) => {
    H.claims.value = claimsFor(sub);
    const el = await call("c_a");
    expect(noticeOf(el)).toBe("forbidden");
    expect(findElement(el, EditClientForm)).toBeNull();
  });

  it("cliente de otra organización -> notFound() (idéntico a inexistente)", async () => {
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

describe("UI — la confirmación de borrado no usa window.confirm", () => {
  it("client-actions.tsx no invoca confirm()/alert()/prompt()", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../app/(app)/client/[id]/dashboard/client-actions.tsx", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\s*\(/);
    expect(src).toMatch(/Sí, eliminar/);
  });
});
