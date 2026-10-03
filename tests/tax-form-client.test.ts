import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAX_GENERIC_ERROR, taxErrorMessage } from "@/lib/tax-form-client";

const repo = fileURLToPath(new URL("../", import.meta.url));
const BUSY_MESSAGE = "El período está siendo modificado por otra operación. Esperá unos segundos y volvé a intentarlo.";

describe("taxErrorMessage — errores del alta de retenciones/percepciones", () => {
  it("contrato actual { error: { code, message } } -> el mensaje", () => {
    expect(taxErrorMessage({ error: { code: "NOT_FOUND", message: "No encontrado." } })).toBe("No encontrado.");
  });

  it("409 PERIOD_BUSY -> el mensaje EXACTO del servidor", () => {
    expect(taxErrorMessage({ error: { code: "PERIOD_BUSY", message: BUSY_MESSAGE } })).toBe(BUSY_MESSAGE);
  });

  it("422 con field -> `field: mensaje`", () => {
    expect(taxErrorMessage({ error: { code: "UNPROCESSABLE_ENTITY", message: "Monto inválido." }, field: "amount" })).toBe("amount: Monto inválido.");
  });

  it("compatibilidad: { error: \"texto\" } (y con field) -> ese texto", () => {
    expect(taxErrorMessage({ error: "Error viejo" })).toBe("Error viejo");
    expect(taxErrorMessage({ error: "Monto inválido", field: "amount" })).toBe("amount: Monto inválido");
  });

  it.each([
    ["null (JSON inválido)", null],
    ["string", "x"],
    ["sin error", {}],
    ["error vacío", { error: "" }],
    ["objeto sin mensaje", { error: { code: "INTERNAL" } }],
    ["mensaje no string", { error: { code: "X", message: {} } }],
    ["error objeto vacío", { error: {} }],
    ["error numérico", { error: 42 }],
  ])("respuesta inválida o sin mensaje (%s) -> genérico, nunca [object Object]", (_l, body) => {
    const message = taxErrorMessage(body);
    expect(message).toBe(TAX_GENERIC_ERROR);
    expect(message).not.toMatch(/object Object/);
  });

  it("el genérico es el mismo texto que usaba la pantalla", () => {
    expect(TAX_GENERIC_ERROR).toBe("Error al crear el registro");
  });
});

describe("pantalla de alta de retenciones — usa taxErrorMessage sin cambiar el envío", () => {
  const page = readFileSync(repo + "app/(app)/client/[id]/period/[periodId]/taxes/new/page.tsx", "utf8");

  it("traduce el error con taxErrorMessage y ya no interpola `j.error`", () => {
    expect(page).toMatch(/import \{ taxErrorMessage \} from "@\/lib\/tax-form-client";/);
    expect(page).toContain("throw new Error(taxErrorMessage(j));");
    expect(page).not.toMatch(/j\?\.error|j\.error|j\?\.field/);
  });

  it("el envío no cambia: POST JSON a /api/taxes con los campos del formulario y el periodId; éxito -> listado", () => {
    expect(page).toMatch(/fetch\("\/api\/taxes", \{\s*method: "POST",\s*headers: \{ "Content-Type": "application\/json" \},\s*body: JSON\.stringify\(\{\s*\.\.\.data,\s*periodId,\s*\}\),\s*\}\)/);
    expect(page).toContain("router.push(`/client/${id}/period/${periodId}/taxes`);");
  });
});
