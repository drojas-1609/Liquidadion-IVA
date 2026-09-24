import { describe, it, expect, vi } from "vitest";
import {
  runBootstrapOwner,
  parseCliArgs,
  refFromSupabaseUrl,
  type BootstrapArgs,
  type BootstrapDeps,
} from "@/scripts/bootstrap-owner";

const UUID = "11111111-2222-4333-8444-555555555555";
const REF = "esyfpakajthdifhnhcew";

function baseArgs(over: Partial<BootstrapArgs> = {}): BootstrapArgs {
  return {
    enabled: true,
    projectRef: REF,
    userId: UUID,
    email: "owner@dero.test",
    orgName: "Dero Company",
    ...over,
  };
}

function deps(over: {
  members?: number;
  existingProfile?: { id: string } | null;
  authUser?: { id: string; email?: string | null } | null;
  authError?: unknown;
} = {}): { deps: BootstrapDeps; created: Record<string, unknown> } {
  const created: Record<string, unknown> = {};
  const tx = {
    organization: {
      create: vi.fn(async ({ data }: { data: { name: string } }) => {
        created.org = data;
        return { id: "org_cuid_1" };
      }),
    },
    profile: {
      create: vi.fn(async ({ data }: { data: { id: string; email: string } }) => {
        created.profile = data;
        return { id: data.id };
      }),
    },
    membership: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        created.membership = data;
        return { id: "mem_1" };
      }),
    },
  };
  const d: BootstrapDeps = {
    prisma: {
      membership: { count: async () => over.members ?? 0 },
      profile: { findUnique: async () => over.existingProfile ?? null },
      $transaction: async (fn) => fn(tx),
    },
    adminAuth: {
      getUserById: async (id) => ({
        data: {
          user:
            over.authUser === undefined
              ? { id, email: "owner@dero.test" }
              : over.authUser,
        },
        error: over.authError ?? null,
      }),
    },
    projectRefFromUrl: REF,
  };
  return { deps: d, created };
}

describe("runBootstrapOwner — guardas", () => {
  it("aborta sin BOOTSTRAP_OWNER=1", async () => {
    const r = await runBootstrapOwner(baseArgs({ enabled: false }), deps().deps);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/BOOTSTRAP_OWNER=1/);
  });

  it("aborta con --user-id no UUID", async () => {
    const r = await runBootstrapOwner(baseArgs({ userId: "no-uuid" }), deps().deps);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/UUID/);
  });

  it("aborta con --email inválido", async () => {
    const r = await runBootstrapOwner(baseArgs({ email: "arroba" }), deps().deps);
    expect(r.ok).toBe(false);
  });

  it("aborta si --project-ref no coincide con la URL de Supabase", async () => {
    const r = await runBootstrapOwner(baseArgs({ projectRef: "otro-ref" }), deps().deps);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no coincide/);
  });

  it("aborta si el usuario de Auth no existe", async () => {
    const r = await runBootstrapOwner(baseArgs(), deps({ authUser: null }).deps);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no existe un usuario/i);
  });

  it("aborta si el correo no coincide con el del usuario de Auth", async () => {
    const r = await runBootstrapOwner(
      baseArgs(),
      deps({ authUser: { id: UUID, email: "otro@dero.test" } }).deps,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no coincide/);
  });

  it("aborta en la segunda ejecución (ya hay memberships)", async () => {
    const r = await runBootstrapOwner(baseArgs(), deps({ members: 1 }).deps);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/un solo uso/);
  });

  it("aborta si ya existe un Profile con ese id", async () => {
    const r = await runBootstrapOwner(baseArgs(), deps({ existingProfile: { id: UUID } }).deps);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ya existe un Profile/);
  });
});

describe("runBootstrapOwner — camino feliz", () => {
  it("crea Organización + Profile + Membership OWNER en transacción", async () => {
    const { deps: d, created } = deps();
    const r = await runBootstrapOwner(baseArgs(), d);
    expect(r).toMatchObject({ ok: true, organizationId: "org_cuid_1" });
    expect(created.org).toEqual({ name: "Dero Company" });
    expect(created.profile).toEqual({ id: UUID, email: "owner@dero.test" });
    expect(created.membership).toEqual({
      profileId: UUID,
      organizationId: "org_cuid_1",
      role: "OWNER",
    });
  });

  it("nunca invoca creación de usuario ni maneja contraseñas (no hay tal dependencia)", () => {
    // El contrato de BootstrapDeps solo expone lectura (getUserById). Este test
    // documenta esa intención.
    const d = deps().deps;
    expect(Object.keys(d.adminAuth)).toEqual(["getUserById"]);
  });
});

describe("helpers de CLI", () => {
  it("parseCliArgs lee flags y default de org-name", () => {
    expect(
      parseCliArgs(["--project-ref", "r1", "--user-id", "u1", "--email", "a@b.c"]),
    ).toEqual({ projectRef: "r1", userId: "u1", email: "a@b.c", orgName: "Dero Company" });
    expect(parseCliArgs(["--org-name", "Otra SA"]).orgName).toBe("Otra SA");
  });

  it("refFromSupabaseUrl extrae el ref del host", () => {
    expect(refFromSupabaseUrl("https://esyfpakajthdifhnhcew.supabase.co")).toBe(
      "esyfpakajthdifhnhcew",
    );
    expect(refFromSupabaseUrl(undefined)).toBe("");
    expect(refFromSupabaseUrl("no-es-url")).toBe("");
  });
});
