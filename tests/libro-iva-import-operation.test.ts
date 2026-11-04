import { describe, it, expect } from "vitest";
import { failureText, isOperationId, operatorState, RESULT_WAIT_MS, resultText } from "@/lib/libro-iva-import/operation";

describe("estado de una confirmación para el operador", () => {
    const t0 = 1_000_000;
    it("aplicada o fallida según el AuditLog, sin importar el tiempo", () => {
        expect(operatorState({ status: "APPLIED" }, t0, t0 + 10 * RESULT_WAIT_MS)).toBe("APPLIED");
        expect(operatorState({ status: "FAILED" }, t0, t0 + 1)).toBe("FAILED");
    });
    it("sin registro: en curso mientras no pasó el límite de la función; después, no aplicada", () => {
        expect(operatorState({ status: "NOT_FOUND" }, t0, t0 + RESULT_WAIT_MS - 1)).toBe("IN_PROGRESS");
        expect(operatorState({ status: "NOT_FOUND" }, t0, t0 + RESULT_WAIT_MS)).toBe("NOT_APPLIED");
        expect(RESULT_WAIT_MS).toBeGreaterThan(60_000);
    });
    it("identificador y textos", () => {
        expect(isOperationId("0f3b9a2e-1c4d-4e5f-8a6b-7c8d9e0f1a2b")).toBe(true);
        expect(isOperationId("0f3b9a2e-1c4d-4e5f-8a6b")).toBe(false);
        expect(failureText("PERIOD_CLOSED")).toMatch(/cerrado/);
        expect(failureText("P2028")).toMatch(/tiempo/);
        expect(failureText("ALGO")).toMatch(/ALGO/);
        expect(resultText({ imported: 3, turiva: 0, duplicates: 1, notImported: 2 })).toBe("Importados 3 comprobantes (0 de TurIVA). Omitidos por ya cargados: 1. No importados (error o revisión): 2.");
    });
});
