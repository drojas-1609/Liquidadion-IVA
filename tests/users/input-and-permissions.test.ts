import { describe, it, expect, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import { normalizeEmail, parseInvite, parsePermissions } from "@/lib/users/input";
import { effectivePermissions, modulesAllow, APP_MODULES } from "@/lib/auth/permissions";
import { recipientAllowed, redirectAllowed } from "@/lib/users/invitation-mailer";
import { sanitizeAuditMetadata } from "@/lib/auth/audit";
import { ASSIGNABLE_ROLES, ROLES_USER_MANAGE } from "@/lib/auth/roles";

describe("parseInvite / parsePermissions", () => {
  const base = { email: "  Ana.Sintetica+1@Example.TEST ", role: "ACCOUNTANT", clientScope: "ALL", modules: ["IVA", "CLIENTS"] };

  it("normaliza el correo y ordena módulos canónicamente; ALL ignora clientIds", () => {
    const r = parseInvite({ ...base, clientIds: ["c1"] });
    expect(r).toEqual({
      ok: true,
      data: { email: "ana.sintetica+1@example.test", role: "ACCOUNTANT", clientScope: "ALL", clientIds: [], modules: ["CLIENTS", "IVA"] },
    });
  });

  it("OWNER nunca es asignable (ni por invitación ni por cambio de permisos)", () => {
    expect(parseInvite({ ...base, role: "OWNER" })).toMatchObject({ ok: false, field: "role" });
    expect(parsePermissions({ ...base, role: "OWNER" })).toMatchObject({ ok: false, field: "role" });
    expect(ASSIGNABLE_ROLES).not.toContain("OWNER");
    expect(ROLES_USER_MANAGE).toEqual(["OWNER"]);
  });

  it("SELECTED exige al menos un cliente; deduplica; rechaza ids malformados", () => {
    expect(parsePermissions({ ...base, clientScope: "SELECTED", clientIds: [] })).toMatchObject({ ok: false, field: "clientIds" });
    expect(parsePermissions({ ...base, clientScope: "SELECTED" })).toMatchObject({ ok: false, field: "clientIds" });
    expect(parsePermissions({ ...base, clientScope: "SELECTED", clientIds: ["a b"] })).toMatchObject({ ok: false, field: "clientIds" });
    expect(parsePermissions({ ...base, clientScope: "SELECTED", clientIds: ["c1", "c1", "c2"] })).toMatchObject({
      ok: true,
      data: { clientIds: ["c1", "c2"] },
    });
  });

  it("módulos: al menos uno y sólo implementados", () => {
    expect(parsePermissions({ ...base, modules: [] })).toMatchObject({ ok: false, field: "modules" });
    expect(parsePermissions({ ...base, modules: ["LIBRO_IVA"] })).toMatchObject({ ok: false, field: "modules" });
  });

  it("correo inválido", () => {
    for (const e of ["", "sin-arroba", "a@b", "a b@c.com", 42, null]) expect(normalizeEmail(e)).toBeNull();
    expect(parseInvite({ ...base, email: "x" })).toMatchObject({ ok: false, field: "email" });
  });

  it("ignora campos ajenos (organizationId, status)", () => {
    const r = parsePermissions({ ...base, organizationId: "org_b", status: "ACTIVE" });
    expect(r.ok && Object.keys(r.data).sort()).toEqual(["clientIds", "clientScope", "modules", "role"]);
  });
});

describe("permisos efectivos", () => {
  it("OWNER: todo, aunque las columnas digan otra cosa", () => {
    expect(effectivePermissions({ role: "OWNER", status: "ACTIVE", clientScope: "SELECTED", modules: [] })).toEqual({
      role: "OWNER",
      clientScope: "ALL",
      modules: APP_MODULES,
    });
  });
  it("resto: filtra módulos desconocidos; alcance desconocido -> SELECTED", () => {
    expect(
      effectivePermissions({ role: "VIEWER", status: "ACTIVE", clientScope: "X" as never, modules: ["IVA", "OTRO" as never] }),
    ).toEqual({ role: "VIEWER", clientScope: "SELECTED", modules: ["IVA"] });
  });
  it("modulesAllow: uno o cualquiera de una lista", () => {
    expect(modulesAllow(["IVA"], "IVA")).toBe(true);
    expect(modulesAllow(["IVA"], ["CLIENTS", "IVA"])).toBe(true);
    expect(modulesAllow(["IVA"], "CLIENTS")).toBe(false);
  });
});

describe("guarda de destinatarios del correo de invitación", () => {
  it("sin lista: no envía a nadie", () => {
    expect(recipientAllowed("ana@example.test", { CONTEXT: "deploy-preview" })).toBe(false);
    expect(recipientAllowed("ana@example.test", {})).toBe(false);
    expect(recipientAllowed("ana@example.test", { USER_INVITE_EMAIL_ALLOWLIST: " , " })).toBe(false);
  });
  it("con lista: sólo direcciones exactas o patrones con *", () => {
    const env = { USER_INVITE_EMAIL_ALLOWLIST: "pruebas+*@example.test, otra@example.test" } as unknown as NodeJS.ProcessEnv;
    expect(recipientAllowed("pruebas+u1@example.test", env)).toBe(true);
    expect(recipientAllowed("otra@example.test", env)).toBe(true);
    expect(recipientAllowed("empleada@example.test", env)).toBe(false);
    expect(recipientAllowed("pruebas+u1@example.test.evil.com", env)).toBe(false);
  });
  it("CONTEXT=production no abre la guarda (en runtime de Netlify CONTEXT no existe; etapa DEV)", () => {
    expect(recipientAllowed("ana@example.test", { CONTEXT: "production" })).toBe(false);
    expect(recipientAllowed("ana@example.test", { CONTEXT: "production", USER_INVITE_EMAIL_ALLOWLIST: "otra@example.test" })).toBe(false);
  });
  it("destino del enlace: sólo la URL exacta configurada (https o localhost), sin parámetros", () => {
    const P = "https://deploy-preview-28--derocompanygestion.netlify.app/auth/accept-invite";
    expect(redirectAllowed(P, {})).toBe(false);
    expect(redirectAllowed(P, { USER_INVITE_REDIRECT_URL: P })).toBe(true);
    expect(redirectAllowed(P, { USER_INVITE_REDIRECT_URL: ` ${P} ` })).toBe(true);
    expect(redirectAllowed("https://deploy-preview-25--derocompanygestion.netlify.app/auth/accept-invite", { USER_INVITE_REDIRECT_URL: P })).toBe(false);
    expect(redirectAllowed(P + "?x=1", { USER_INVITE_REDIRECT_URL: P + "?x=1" })).toBe(false);
    expect(redirectAllowed("http://evil.test/auth/accept-invite", { USER_INVITE_REDIRECT_URL: "http://evil.test/auth/accept-invite" })).toBe(false);
    expect(redirectAllowed("https://x.test/otra", { USER_INVITE_REDIRECT_URL: "https://x.test/otra" })).toBe(false);
    expect(redirectAllowed("http://localhost:3000/auth/accept-invite", { USER_INVITE_REDIRECT_URL: "http://localhost:3000/auth/accept-invite" })).toBe(true);
  });
  it("el comodín no cruza la @ ni admite espacios", () => {
    const env = { USER_INVITE_EMAIL_ALLOWLIST: "pruebas+*@example.test" };
    expect(recipientAllowed("pruebas+a@evil.test@example.test", env)).toBe(false);
    expect(recipientAllowed("pruebas+a b@example.test", env)).toBe(false);
  });
});

describe("auditoría mínima de usuarios", () => {
  it("nunca persiste correo, nombre, ids de clientes ni tokens", () => {
    const meta = sanitizeAuditMetadata("member.invite", {
      role: "VIEWER",
      clientScope: "SELECTED",
      clientCount: 2,
      modules: "IVA",
      email: "ana@example.test",
      clientIds: ["c1", "c2"],
      token: "x",
    });
    expect(meta).toEqual({ role: "VIEWER", clientScope: "SELECTED", clientCount: 2, modules: "IVA" });
    expect(sanitizeAuditMetadata("member.invite_resend", { email: "a@b.c" })).toEqual({});
    expect(sanitizeAuditMetadata("member.disable", { role: "ADMIN", email: "a@b.c" })).toEqual({ role: "ADMIN" });
  });
});
