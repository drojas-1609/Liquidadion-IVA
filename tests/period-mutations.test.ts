import { describe, it, expect, vi } from "vitest";
import {
    submitNewPeriod,
    submitPeriodDelete,
    createPeriodErrorMessage,
    deletePeriodErrorMessage,
    duplicatePeriodError,
    CREATE_PERIOD_GENERIC_ERROR,
    DELETE_PERIOD_GENERIC_ERROR,
    PERIOD_CLIENT_NOT_FOUND_ERROR,
    PERIOD_NOT_FOUND_ERROR,
    CREATE_PERIOD_FORBIDDEN_ERROR,
    DELETE_PERIOD_FORBIDDEN_ERROR,
    DELETE_PERIOD_HAS_MOVEMENTS_ERROR,
} from "@/lib/period-mutations";

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function fetchReturning(res: Response | Error) {
    return vi.fn(async () => {
        if (res instanceof Error) throw res;
        return res;
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const err = (code: string, message: string, field?: string) => ({
    error: { code, message },
    ...(field ? { field } : {}),
});
const DATA = { clientId: "c_1", month: 3, year: 2026 };

describe("submitNewPeriod", () => {
    it("POST JSON a /api/periods con { clientId, month, year } -> ok", async () => {
        const fetchImpl = fetchReturning(jsonResponse(201, { id: "p_1" }));
        expect(await submitNewPeriod(DATA, fetchImpl)).toEqual({ ok: true });
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/periods");
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual(DATA);
    });

    it.each([
        ["409 duplicado", jsonResponse(409, err("CONFLICT", "Ya existe un registro con esos datos.")), "Ya existe el período 03/2026 para este cliente."],
        ["404 cliente", jsonResponse(404, err("NOT_FOUND", "No encontrado.")), PERIOD_CLIENT_NOT_FOUND_ERROR],
        ["403 sin permisos", jsonResponse(403, err("FORBIDDEN", "No tenés permisos para esta operación.")), CREATE_PERIOD_FORBIDDEN_ERROR],
        ["422 año", jsonResponse(422, err("UNPROCESSABLE_ENTITY", "año inválido (2000 a 2027)", "year")), "Año: año inválido (2000 a 2027)"],
        ["422 mes", jsonResponse(422, err("UNPROCESSABLE_ENTITY", "mes inválido (1 a 12)", "month")), "Mes: mes inválido (1 a 12)"],
        ["401", jsonResponse(401, err("UNAUTHENTICATED", "Necesitás iniciar sesión.")), "Necesitás iniciar sesión."],
        ["500 INTERNAL", jsonResponse(500, err("INTERNAL", "Error interno.")), CREATE_PERIOD_GENERIC_ERROR],
        ["500 sin JSON", new Response("<html>", { status: 500 }), CREATE_PERIOD_GENERIC_ERROR],
        ["error de red", new Error("offline"), CREATE_PERIOD_GENERIC_ERROR],
    ])("%s -> mensaje legible", async (_label, res, expected) => {
        expect(await submitNewPeriod(DATA, fetchReturning(res))).toEqual({ ok: false, message: expected });
    });

    it("nunca produce [object Object]", () => {
        expect(createPeriodErrorMessage({ error: { code: 1, message: { x: 1 } } }, DATA)).toBe(CREATE_PERIOD_GENERIC_ERROR);
        expect(createPeriodErrorMessage(null, DATA)).toBe(CREATE_PERIOD_GENERIC_ERROR);
    });

    it("duplicatePeriodError usa la etiqueta canónica MM/AAAA", () => {
        expect(duplicatePeriodError({ year: 2025, month: 11 })).toBe("Ya existe el período 11/2025 para este cliente.");
    });
});

describe("submitPeriodDelete", () => {
    it("DELETE a /api/periods/[id] (id codificado); 204 -> ok", async () => {
        const fetchImpl = fetchReturning(new Response(null, { status: 204 }));
        expect(await submitPeriodDelete("p/1", fetchImpl)).toEqual({ ok: true });
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/periods/p%2F1");
        expect(init.method).toBe("DELETE");
    });

    it.each([
        ["409 con movimientos", jsonResponse(409, err("CONFLICT", "x")), DELETE_PERIOD_HAS_MOVEMENTS_ERROR],
        ["404", jsonResponse(404, err("NOT_FOUND", "No encontrado.")), PERIOD_NOT_FOUND_ERROR],
        ["403", jsonResponse(403, err("FORBIDDEN", "x")), DELETE_PERIOD_FORBIDDEN_ERROR],
        ["500 INTERNAL", jsonResponse(500, err("INTERNAL", "Error interno.")), DELETE_PERIOD_GENERIC_ERROR],
        ["500 sin JSON", new Response("x", { status: 500 }), DELETE_PERIOD_GENERIC_ERROR],
        ["error de red", new Error("offline"), DELETE_PERIOD_GENERIC_ERROR],
    ])("%s -> mensaje legible", async (_label, res, expected) => {
        expect(await submitPeriodDelete("p_1", fetchReturning(res))).toEqual({ ok: false, message: expected });
    });

    it("cuerpo no reconocible -> genérico", () => {
        expect(deletePeriodErrorMessage({ foo: "bar" })).toBe(DELETE_PERIOD_GENERIC_ERROR);
    });

    it("todos los mensajes visibles escriben 'período' con tilde", () => {
        for (const m of [
            CREATE_PERIOD_GENERIC_ERROR,
            DELETE_PERIOD_GENERIC_ERROR,
            PERIOD_NOT_FOUND_ERROR,
            DELETE_PERIOD_HAS_MOVEMENTS_ERROR,
            duplicatePeriodError(DATA),
        ]) {
            expect(m).toMatch(/período/);
            expect(m).not.toMatch(/periodo/i);
        }
    });
});
