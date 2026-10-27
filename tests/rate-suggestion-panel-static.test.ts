import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Revisión ESTÁTICA del panel de asistencia de alícuotas (no es una prueba en
 * navegador): garantías que no deben perderse al editar el componente.
 */
const panel = readFileSync(new URL("../app/(app)/clients/_components/rate-suggestion-panel.tsx", import.meta.url), "utf8");

describe("panel de asistencia de alícuotas — revisión estática", () => {
    it("los hechos declarados arrancan «Sin indicar» y no hay valores preseleccionados", () => {
        expect(panel).toContain("useState<Record<string, boolean>>({})");
        expect(panel).toContain('value={declared[key] === undefined ? "" : declared[key] ? "si" : "no"}');
        expect(panel.indexOf('<option value="">Sin indicar</option>')).toBeLessThan(panel.indexOf('<option value="si">Sí</option>'));
        expect(panel).not.toMatch(/defaultChecked|defaultValue=\{?["']si/);
    });
    it("sólo una respuesta única sin condiciones se confirma como sugerencia de la norma", () => {
        expect(panel).toContain('s.status === "UNICA" && a.conditions.length === 0 ?');
        expect(panel.match(/onConfirm\(a\)/g)).toHaveLength(1);
    });
    it("lo no acreditable se registra como decisión del estudio, con constancia explícita sin marcar por defecto", () => {
        expect(panel).toContain("onRecordAsStudioDecision(a)");
        expect(panel).toContain("disabled={accepted[a.ruleRef] !== true}");
        expect(panel).toContain("checked={accepted[a.ruleRef] === true}");
        expect(panel).toContain("setAccepted({});");
        const form = readFileSync(new URL("../app/(app)/clients/_components/client-profile-form.tsx", import.meta.url), "utf8");
        expect(form).toContain('origin: "STUDIO_MANUAL", ruleRef: null });');
    });
    it("explica qué se reemplaza y qué se registra; nada se guarda hasta «Guardar» la ficha", () => {
        expect(panel).toContain("Registrar una alternativa reemplaza sólo este valor en el borrador; nada cambia en la base hasta «Guardar» la ficha");
        expect(panel).toContain("como decisión del estudio («Tasa manual confirmada por el estudio»), sin referencia a la norma");
        const form = readFileSync(new URL("../app/(app)/clients/_components/client-profile-form.tsx", import.meta.url), "utf8");
        expect(form).toMatch(/current=\{\s*r\.associated/);
    });
    it("la consulta usa una fecha de referencia elegible y la envía al servidor", () => {
        expect(panel).toContain('type="date"');
        expect(panel).toMatch(/registration,\s*date,\s*facts:/);
    });
    it("informa las reglas retenidas en lugar de ocultarlas", () => {
        expect(panel).toContain("s.held.length > 0");
    });
    it("confirmar sólo incorpora al borrador (se guarda con la ficha)", () => {
        expect(panel).toContain("onClick={() => onConfirm(a)}");
        expect(panel).toContain("onClick={() => onRecordAsStudioDecision(a)}");
        expect(panel).not.toMatch(/fetch\(|requestJson|PATCH/);
    });
});
