/**
 * Contrato de la plantilla "Reset Password" de Supabase que habrá que aplicar
 * (docs/auth/reset-password-email-template.html). Impide regresar al enlace
 * auto-verificado vulnerable a escáneres.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const tpl = readFileSync(repo + "docs/auth/reset-password-email-template.html", "utf8");

describe("plantilla Reset Password — contrato", () => {
  it("construye el enlace con {{ .RedirectTo }}", () => {
    expect(tpl).toMatch(/href="\{\{\s*\.RedirectTo\s*\}\}/);
  });

  it("incluye token_hash={{ .TokenHash }}", () => {
    expect(tpl).toMatch(/token_hash=\{\{\s*\.TokenHash\s*\}\}/);
  });

  it("incluye type=recovery como parámetro del enlace", () => {
    expect(tpl).toMatch(/href="[^"]*(?:&amp;|[?&])type=recovery\b/);
  });

  it("NO usa {{ .ConfirmationURL }}", () => {
    expect(tpl).not.toMatch(/\{\{\s*\.ConfirmationURL\s*\}\}/);
  });

  it("NO usa {{ .SiteURL }} como destino del enlace", () => {
    // puede mencionarse en un comentario, pero nunca dentro de un href=
    expect(tpl).not.toMatch(/href="[^"]*\{\{\s*\.SiteURL\s*\}\}/);
  });

  it("el enlace apunta a /auth/confirm-recovery (la página intermedia)", () => {
    // el path lo aporta `redirectTo` en requestResetAction; acá se documenta
    expect(tpl).toMatch(/\/auth\/confirm-recovery|confirm-recovery/);
  });

  it("escapa el separador de query como &amp; (HTML válido)", () => {
    expect(tpl).toMatch(/token_hash=\{\{\s*\.TokenHash\s*\}\}&amp;type=recovery/);
    // no debe quedar un & crudo entre los parámetros del href
    expect(tpl).not.toMatch(/token_hash=\{\{\s*\.TokenHash\s*\}\}&type=recovery/);
  });
});
