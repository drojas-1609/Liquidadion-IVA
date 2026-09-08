import { describe, it, expect } from "vitest";
import type { Role } from "@prisma/client";
import {
  ROLES_READ,
  ROLES_CREATE,
  ROLES_EXPORT,
  ROLES_UPDATE,
  ROLES_DELETE,
  ROLES_IMPORT,
  ROLES_MEMBERS,
  ROLES_ROLE_CHANGE,
  ROLES_CONFIG,
  ROLES_AUDIT_READ,
  ROLES_ORG_DELETE,
  roleAllows,
} from "@/lib/auth/roles";

const ALL: Role[] = ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"];
const sorted = (rs: readonly Role[]) => [...rs].sort();

/**
 * La matriz aprobada, celda por celda. Si una constante cambia de forma no
 * autorizada, o una función futura se cablea a la constante equivocada, cae
 * un test.
 */
const MATRIX: Record<string, { roles: readonly Role[]; allowed: Role[] }> = {
  // Implementadas en 3B
  ROLES_READ: { roles: ROLES_READ, allowed: ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"] },
  ROLES_CREATE: { roles: ROLES_CREATE, allowed: ["OWNER", "ADMIN", "ACCOUNTANT"] },
  ROLES_EXPORT: { roles: ROLES_EXPORT, allowed: ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"] },
  // Futuras
  ROLES_UPDATE: { roles: ROLES_UPDATE, allowed: ["OWNER", "ADMIN", "ACCOUNTANT"] },
  ROLES_DELETE: { roles: ROLES_DELETE, allowed: ["OWNER", "ADMIN"] },
  ROLES_IMPORT: { roles: ROLES_IMPORT, allowed: ["OWNER", "ADMIN", "ACCOUNTANT"] },
  ROLES_MEMBERS: { roles: ROLES_MEMBERS, allowed: ["OWNER", "ADMIN"] },
  ROLES_ROLE_CHANGE: { roles: ROLES_ROLE_CHANGE, allowed: ["OWNER"] },
  ROLES_CONFIG: { roles: ROLES_CONFIG, allowed: ["OWNER", "ADMIN"] },
  ROLES_AUDIT_READ: { roles: ROLES_AUDIT_READ, allowed: ["OWNER", "ADMIN"] },
  ROLES_ORG_DELETE: { roles: ROLES_ORG_DELETE, allowed: ["OWNER"] },
};

describe("lib/auth/roles — matriz aprobada (Tarea 3B)", () => {
  for (const [name, { roles, allowed }] of Object.entries(MATRIX)) {
    it(`${name}: exactamente ${JSON.stringify(allowed)}`, () => {
      expect(sorted(roles)).toEqual(sorted(allowed));
      for (const r of ALL) {
        expect(roleAllows(roles, r), `${name} / ${r}`).toBe(allowed.includes(r));
      }
    });
  }

  it("VIEWER sólo lee y exporta; nunca crea/actualiza/borra/importa/administra", () => {
    expect(roleAllows(ROLES_READ, "VIEWER")).toBe(true);
    expect(roleAllows(ROLES_EXPORT, "VIEWER")).toBe(true);
    for (const c of [
      ROLES_CREATE,
      ROLES_UPDATE,
      ROLES_DELETE,
      ROLES_IMPORT,
      ROLES_MEMBERS,
      ROLES_ROLE_CHANGE,
      ROLES_CONFIG,
      ROLES_AUDIT_READ,
      ROLES_ORG_DELETE,
    ]) {
      expect(roleAllows(c, "VIEWER")).toBe(false);
    }
  });

  it("ACCOUNTANT: crea e importa, pero no borra, no administra miembros, no config, no auditoría", () => {
    expect(roleAllows(ROLES_CREATE, "ACCOUNTANT")).toBe(true);
    expect(roleAllows(ROLES_UPDATE, "ACCOUNTANT")).toBe(true);
    expect(roleAllows(ROLES_IMPORT, "ACCOUNTANT")).toBe(true);
    for (const c of [
      ROLES_DELETE,
      ROLES_MEMBERS,
      ROLES_ROLE_CHANGE,
      ROLES_CONFIG,
      ROLES_AUDIT_READ,
      ROLES_ORG_DELETE,
    ]) {
      expect(roleAllows(c, "ACCOUNTANT")).toBe(false);
    }
  });

  it("ADMIN administra miembros y config, pero NO cambia roles ni elimina la organización", () => {
    expect(roleAllows(ROLES_MEMBERS, "ADMIN")).toBe(true);
    expect(roleAllows(ROLES_CONFIG, "ADMIN")).toBe(true);
    expect(roleAllows(ROLES_AUDIT_READ, "ADMIN")).toBe(true);
    expect(roleAllows(ROLES_ROLE_CHANGE, "ADMIN")).toBe(false);
    expect(roleAllows(ROLES_ORG_DELETE, "ADMIN")).toBe(false);
  });

  it("OWNER puede todo (incluye cambiar roles y eliminar la organización)", () => {
    for (const c of Object.values(MATRIX)) {
      expect(roleAllows(c.roles, "OWNER")).toBe(true);
    }
  });

  it("cambiar roles y eliminar la organización son exclusivos de OWNER", () => {
    expect(sorted(ROLES_ROLE_CHANGE)).toEqual(["OWNER"]);
    expect(sorted(ROLES_ORG_DELETE)).toEqual(["OWNER"]);
  });

  it("ROLES_EXPORT es idéntico a ROLES_READ", () => {
    expect(sorted(ROLES_EXPORT)).toEqual(sorted(ROLES_READ));
  });
});
