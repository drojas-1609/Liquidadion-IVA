import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const schema = readFileSync(repo + "prisma/schema.prisma", "utf8");

function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  if (start === -1) throw new Error(`model ${name} no encontrado`);
  return schema.slice(start, schema.indexOf("\n}", start) + 2);
}

describe("schema.prisma — modelo de organización (Tarea 3A)", () => {
  it("Profile: id es String @id @db.Uuid, SIN @default; email SIN @unique", () => {
    const b = modelBlock("Profile");
    expect(b).toMatch(/id\s+String\s+@id\s+@db\.Uuid/);
    expect(b).not.toMatch(/id\s+String\s+@id[^\n]*@default/);
    expect(b).toMatch(/^\s*email\s+String\s*$/m); // sin @unique
    expect(b).not.toMatch(/email\s+String\s+@unique/);
  });

  it("enum Role con OWNER, ADMIN, ACCOUNTANT, VIEWER", () => {
    const start = schema.indexOf("enum Role {");
    const block = schema.slice(start, schema.indexOf("}", start));
    for (const r of ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"]) {
      expect(block).toContain(r);
    }
  });

  it("Organization y OrgSetting existen; OrgSetting con @@unique([organizationId, key])", () => {
    expect(schema).toMatch(/model Organization \{/);
    const b = modelBlock("OrgSetting");
    expect(b).toMatch(/@@unique\(\[organizationId, key\]\)/);
  });

  it("Membership con @@unique([profileId, organizationId]) y FKs cascade", () => {
    const b = modelBlock("Membership");
    expect(b).toMatch(/profileId\s+String\s+@db\.Uuid/);
    expect(b).toMatch(/role\s+Role/);
    expect(b).toMatch(/@@unique\(\[profileId, organizationId\]\)/);
    expect(b).toMatch(/onDelete: Cascade/);
  });

  it("Client: cuit SIN @unique global; @@unique([organizationId, cuit]); organizationId OBLIGATORIO", () => {
    const b = modelBlock("Client");
    expect(b).not.toMatch(/cuit\s+String\s+@unique/);
    expect(b).toMatch(/^\s*cuit\s+String\s*$/m);
    expect(b).toMatch(/@@unique\(\[organizationId, cuit\]\)/);
    // organizationId String (no String?) con relación a Organization
    expect(b).toMatch(/organizationId\s+String\s*$/m);
    expect(b).not.toMatch(/organizationId\s+String\?/);
    expect(b).toMatch(/organization\s+Organization\s+@relation/);
    // autoría
    expect(b).toMatch(/createdById\s+String\?\s+@db\.Uuid/);
    expect(b).toMatch(/updatedById\s+String\?\s+@db\.Uuid/);
  });

  it("Period / Invoice / TaxRecord: createdById/updatedById (@db.Uuid, nullable) + createdAt/updatedAt", () => {
    for (const m of ["Period", "Invoice", "TaxRecord"]) {
      const b = modelBlock(m);
      expect(b, m).toMatch(/createdById\s+String\?\s+@db\.Uuid/);
      expect(b, m).toMatch(/updatedById\s+String\?\s+@db\.Uuid/);
      expect(b, m).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/);
      expect(b, m).toMatch(/updatedAt\s+DateTime\s+@updatedAt/);
    }
  });

  it("Settings (global) se conserva intacto", () => {
    const b = modelBlock("Settings");
    expect(b).toMatch(/key\s+String\s+@unique/);
    expect(b).toMatch(/value\s+String/);
    expect(b).not.toMatch(/organizationId/);
  });

  it("Campos monetarios Decimal de Tarea 2 sin cambios", () => {
    const inv = modelBlock("Invoice");
    expect(inv).toMatch(/netAmount\s+Decimal\s+@db\.Decimal\(18, 2\)/);
    expect(inv).toMatch(/vatRate\s+Decimal\s+@db\.Decimal\(9, 6\)/);
    expect(modelBlock("Client")).toMatch(/defaultIibbRate\s+Decimal\s+@default\(3\.000000\)\s+@db\.Decimal\(9, 6\)/);
  });
});
