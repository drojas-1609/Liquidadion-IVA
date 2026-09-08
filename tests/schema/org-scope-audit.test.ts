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

describe("schema.prisma — scope de organización + auditoría (Tarea 3B)", () => {
  it("Period / Invoice / TaxRecord declaran organizationId String (obligatorio)", () => {
    for (const m of ["Period", "Invoice", "TaxRecord"]) {
      const b = modelBlock(m);
      expect(b, m).toMatch(/^\s*organizationId\s+String\s*$/m);
      expect(b, m).not.toMatch(/organizationId\s+String\?/);
    }
  });

  it("Client y Period declaran @@unique([id, organizationId]) (destino de FK compuesta)", () => {
    expect(modelBlock("Client")).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(modelBlock("Period")).toMatch(/@@unique\(\[id, organizationId\]\)/);
  });

  it("Period.client es una relación COMPUESTA sobre (clientId, organizationId) -> Client(id, organizationId)", () => {
    const b = modelBlock("Period");
    expect(b).toMatch(
      /client\s+Client\s+@relation\(fields:\s*\[clientId,\s*organizationId\],\s*references:\s*\[id,\s*organizationId\]/,
    );
    expect(b).toMatch(/onDelete:\s*Restrict/);
  });

  it("Invoice.period y TaxRecord.period son relaciones COMPUESTAS sobre (periodId, organizationId) -> Period(id, organizationId)", () => {
    for (const m of ["Invoice", "TaxRecord"]) {
      const b = modelBlock(m);
      expect(b, m).toMatch(
        /period\s+Period\s+@relation\(fields:\s*\[periodId,\s*organizationId\],\s*references:\s*\[id,\s*organizationId\]/,
      );
      expect(b, m).toMatch(/onDelete:\s*Restrict/);
    }
  });

  it("índices EXPLÍCITOS de las columnas hijas de cada FK compuesta", () => {
    expect(modelBlock("Period")).toMatch(/@@index\(\[clientId, organizationId\]\)/);
    expect(modelBlock("Invoice")).toMatch(/@@index\(\[periodId, organizationId\]\)/);
    expect(modelBlock("TaxRecord")).toMatch(/@@index\(\[periodId, organizationId\]\)/);
  });

  it("índices por organizationId para el scope de consultas", () => {
    for (const m of ["Period", "Invoice", "TaxRecord"]) {
      expect(modelBlock(m), m).toMatch(/@@index\(\[organizationId\]\)/);
    }
  });

  it("los índices simples previos se CONSERVAN hasta confirmar cobertura del compuesto", () => {
    expect(modelBlock("Period")).toMatch(/@@index\(\[clientId\]\)/);
    expect(modelBlock("Invoice")).toMatch(/@@index\(\[periodId\]\)/);
    expect(modelBlock("TaxRecord")).toMatch(/@@index\(\[periodId\]\)/);
  });

  it("existe el modelo AuditLog con los 8 campos y los 2 índices", () => {
    const b = modelBlock("AuditLog");
    for (const f of [
      /id\s+String\s+@id/,
      /organizationId\s+String\s*$/m,
      /actorProfileId\s+String\?\s+@db\.Uuid/,
      /action\s+String\s*$/m,
      /targetType\s+String\s*$/m,
      /targetId\s+String\s*$/m,
      /metadata\s+Json\s*$/m,
      /createdAt\s+DateTime\s+@default\(now\(\)\)/,
    ]) {
      expect(b, String(f)).toMatch(f);
    }
    expect(b).toMatch(/@@index\(\[organizationId, createdAt\]\)/);
    expect(b).toMatch(/@@index\(\[targetType, targetId\]\)/);
  });

  it("AuditLog.organization es onDelete: Restrict (NO Cascade): el historial no se borra en cascada", () => {
    const b = modelBlock("AuditLog");
    const orgRel = b.split("\n").find((l) => /organization\s+Organization\s+@relation/.test(l))!;
    expect(orgRel).toMatch(/onDelete:\s*Restrict/);
    expect(orgRel).not.toMatch(/onDelete:\s*Cascade/);
  });

  it("AuditLog.actor es opcional con onDelete: SetNull", () => {
    const b = modelBlock("AuditLog");
    const actorRel = b.split("\n").find((l) => /actor\s+Profile\?\s+@relation/.test(l))!;
    expect(actorRel).toMatch(/onDelete:\s*SetNull/);
  });

  it("back-relations de AuditLog en Organization y Profile", () => {
    expect(modelBlock("Organization")).toMatch(/auditLogs\s+AuditLog\[\]\s+@relation\("OrgAuditLogs"\)/);
    expect(modelBlock("Profile")).toMatch(/auditLogs\s+AuditLog\[\]\s+@relation\("ProfileAuditLogs"\)/);
  });

  it("Settings (global) se conserva intacto; Client->Organization sigue sin onDelete explícito (Restrict por defecto)", () => {
    const s = modelBlock("Settings");
    expect(s).toMatch(/key\s+String\s+@unique/);
    expect(s).not.toMatch(/organizationId/);
    const cliOrg = modelBlock("Client")
      .split("\n")
      .find((l) => /organization\s+Organization\s+@relation/.test(l))!;
    expect(cliOrg).not.toMatch(/onDelete:/); // Restrict por defecto (sin cambio 3B)
  });

  it("campos monetarios Decimal de Tarea 2 sin cambios", () => {
    const inv = modelBlock("Invoice");
    expect(inv).toMatch(/netAmount\s+Decimal\s+@db\.Decimal\(18, 2\)/);
    expect(inv).toMatch(/vatRate\s+Decimal\s+@db\.Decimal\(9, 6\)/);
    expect(inv).toMatch(/vatAmount\s+Decimal\s+@db\.Decimal\(18, 2\)/);
    expect(inv).toMatch(/totalAmount\s+Decimal\s+@db\.Decimal\(18, 2\)/);
    expect(modelBlock("TaxRecord")).toMatch(/amount\s+Decimal\s+@db\.Decimal\(18, 2\)/);
    expect(modelBlock("Client")).toMatch(
      /defaultIibbRate\s+Decimal\s+@default\(3\.000000\)\s+@db\.Decimal\(9, 6\)/,
    );
  });
});
