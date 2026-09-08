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
  SUB_NO_PROFILE,
  SUB_NO_ORG,
  ORG_A,
  ORG_B,
} from "../api/_harness";
import { MisconfiguredError } from "@/lib/auth/errors";
import ClientsPage from "@/app/clients/page";
import ClientDashboard from "@/app/client/[id]/dashboard/page";
import { AccessNotice } from "@/app/_components/access-notice";

let db: ReturnType<typeof freshDbMock>;

beforeEach(() => {
  db = freshDbMock();
  const world = makeWorld({
    clients: [clientRow("c_a", ORG_A, { name: "Alfa SA" }), clientRow("c_b", ORG_B, { name: "Beta SA" })],
    periods: [periodRow("p_a", "c_a", ORG_A)],
  });
  wireDb(db, world, freshRecorder());
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noticeOf = (el: any): string | null =>
  el && el.type === AccessNotice ? el.props.notice : null;

describe("app/clients/page — guardPage", () => {
  it("OWNER: renderiza (no AccessNotice) y consulta scoped por organización activa", async () => {
    const el = await ClientsPage();
    expect(noticeOf(el)).toBeNull();
    expect(db.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_A } }),
    );
  });

  it("sin sesión -> redirect('/login')", async () => {
    H.claims.value = null;
    await expect(ClientsPage()).rejects.toThrow("REDIRECT:/login");
  });

  it("sesión sin Profile -> <AccessNotice notice='no-profile'>", async () => {
    H.claims.value = claimsFor(SUB_NO_PROFILE);
    expect(noticeOf(await ClientsPage())).toBe("no-profile");
  });

  it("Profile sin Membership -> <AccessNotice notice='no-organization'>", async () => {
    H.claims.value = claimsFor(SUB_NO_ORG);
    expect(noticeOf(await ClientsPage())).toBe("no-organization");
  });

  it("config de auth ausente -> <AccessNotice notice='misconfigured'>", async () => {
    H.claims.throw = new MisconfiguredError();
    expect(noticeOf(await ClientsPage())).toBe("misconfigured");
  });
});

describe("app/client/[id]/dashboard/page — guardPage + requireClientAccess", () => {
  const call = (id: string) => ClientDashboard({ params: Promise.resolve({ id }) });

  it("cliente propio -> renderiza y consulta scoped por su organización", async () => {
    const el = await call("c_a");
    expect(noticeOf(el)).toBeNull();
    expect(db.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c_a", organizationId: ORG_A } }),
    );
  });

  it("cliente de otra organización -> notFound() (no revela existencia)", async () => {
    await expect(call("c_b")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("cliente inexistente -> notFound() (idéntico a ajeno)", async () => {
    await expect(call("c_zzz")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("sin sesión -> redirect('/login')", async () => {
    H.claims.value = null;
    await expect(call("c_a")).rejects.toThrow("REDIRECT:/login");
  });

  it("OWNER de otra organización sobre c_a -> notFound()", async () => {
    H.claims.value = claimsFor(SUB_OWNER_B);
    await expect(call("c_a")).rejects.toThrow("NOTFOUND_PAGE");
  });
});
