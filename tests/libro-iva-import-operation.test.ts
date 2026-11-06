import { describe, it, expect } from "vitest";
import { failureText, isOperationId, operatorState, RESULT_WAIT_MS, resultText } from "@/lib/libro-iva-import/operation";

describe("estado de una confirmación para el operador", () => {
    const t0 = 1_000_000;
    const A = "0f3b9a2e-1c4d-4e5f-8a6b-7c8d9e0f1a2b";
    const B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    it("aplicada según el AuditLog, sin importar el tiempo ni los envíos fallidos", () => {
        expect(operatorState({ status: "APPLIED" }, [{ attemptId: A, startedAt: t0 }], t0 + 10 * RESULT_WAIT_MS)).toBe("APPLIED");
        expect(operatorState({ status: "APPLIED", failedAttemptIds: [B] }, [{ attemptId: A, startedAt: t0 }, { attemptId: B, startedAt: t0 + 35_000 }], t0 + 36_000)).toBe("APPLIED");
    });
    it("fallida sólo si fallaron todos los envíos (registro propio o respuesta de error)", () => {
        expect(operatorState({ status: "FAILED", failedAttemptIds: [A] }, [{ attemptId: A, startedAt: t0 }], t0 + 1)).toBe("FAILED");
        expect(operatorState({ status: "FAILED", failedAttemptIds: [A] }, [{ attemptId: A, startedAt: t0 }, { attemptId: B, startedAt: t0 + 5, rejected: true }], t0 + 10)).toBe("FAILED");
    });
    it("la falla de un reintento no cierra un envío anterior que pudo seguir vivo (504 mientras escribía)", () => {
        const attempts = [{ attemptId: A, startedAt: t0 }, { attemptId: B, startedAt: t0 + 35_000 }];
        expect(operatorState({ status: "FAILED", failedAttemptIds: [B] }, attempts, t0 + 40_000)).toBe("IN_PROGRESS");
        expect(operatorState({ status: "FAILED", failedAttemptIds: [B] }, attempts, t0 + RESULT_WAIT_MS)).toBe("UNCONFIRMED");
        // Respuesta de error del reintento (409 PERIOD_BUSY): tampoco resuelve el primero.
        expect(operatorState({ status: "NOT_FOUND" }, [attempts[0], { ...attempts[1], rejected: true }], t0 + 40_000)).toBe("IN_PROGRESS");
    });
    it("una falla de OTRO envío no se atribuye al envío seguido", () => {
        expect(operatorState({ status: "FAILED", failedAttemptIds: [A] }, [{ attemptId: A, startedAt: t0, rejected: true }, { attemptId: B, startedAt: t0 + 90_000 }], t0 + 95_000)).toBe("IN_PROGRESS");
        // Fallas sin attemptId (registros previos a este cambio) no cuentan.
        expect(operatorState({ status: "FAILED", failedAttemptIds: [] }, [{ attemptId: A, startedAt: t0 }], t0 + RESULT_WAIT_MS)).toBe("UNCONFIRMED");
    });
    it("sin registro: en curso dentro del plazo; después, sin confirmar (nunca «no aplicada» por tiempo)", () => {
        const one = [{ attemptId: A, startedAt: t0 }];
        expect(operatorState({ status: "NOT_FOUND" }, one, t0 + RESULT_WAIT_MS - 1)).toBe("IN_PROGRESS");
        expect(operatorState({ status: "NOT_FOUND" }, one, t0 + RESULT_WAIT_MS)).toBe("UNCONFIRMED");
        expect(operatorState({ status: "NOT_FOUND" }, one, t0 + 100 * RESULT_WAIT_MS)).toBe("UNCONFIRMED");
        expect(operatorState({ status: "NOT_FOUND" }, [], t0)).toBe("UNCONFIRMED");
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
