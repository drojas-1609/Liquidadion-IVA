import { describe, it, expect, vi } from "vitest";
import {
    submitClientUpdate,
    submitClientDelete,
    updateClientErrorMessage,
    deleteClientErrorMessage,
    UPDATE_CLIENT_GENERIC_ERROR,
    DELETE_CLIENT_GENERIC_ERROR,
    UPDATE_CLIENT_DUPLICATE_CUIT_ERROR,
    DELETE_CLIENT_HAS_PERIODS_ERROR,
    CLIENT_NOT_FOUND_ERROR,
    CLIENT_FORBIDDEN_ERROR,
} from "@/lib/client-mutations";

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
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

describe("submitClientUpdate", () => {
    it("PATCH JSON a /api/clients/[id] y ok=true", async () => {
        const fetchImpl = fetchReturning(jsonResponse(200, { id: "c_1" }));
        const result = await submitClientUpdate("c_1", { name: "Alfa" }, fetchImpl);
        expect(result).toEqual({ ok: true });
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/clients/c_1");
        expect(init.method).toBe("PATCH");
        expect(JSON.parse(String(init.body))).toEqual({ name: "Alfa" });
    });

    it("codifica el id en la URL", async () => {
        const fetchImpl = fetchReturning(jsonResponse(200, {}));
        await submitClientUpdate("a/b?c", {}, fetchImpl);
        expect(fetchImpl.mock.calls[0][0]).toBe("/api/clients/a%2Fb%3Fc");
    });

    it.each([
        ["422 con field cuit", jsonResponse(422, err("UNPROCESSABLE_ENTITY", "CUIT inválido: dígito verificador incorrecto", "cuit")), "CUIT: CUIT inválido: dígito verificador incorrecto"],
        ["422 con field defaultIibbRate", jsonResponse(422, err("UNPROCESSABLE_ENTITY", "valor inválido", "defaultIibbRate")), "Alícuota IIBB: valor inválido"],
        ["422 sin campos (field body)", jsonResponse(422, err("UNPROCESSABLE_ENTITY", "no hay campos para actualizar", "body")), "no hay campos para actualizar"],
        ["409 CONFLICT", jsonResponse(409, err("CONFLICT", "Ya existe un registro con esos datos.")), UPDATE_CLIENT_DUPLICATE_CUIT_ERROR],
        ["404", jsonResponse(404, err("NOT_FOUND", "No encontrado.")), CLIENT_NOT_FOUND_ERROR],
        ["403", jsonResponse(403, err("FORBIDDEN", "No tenés permisos para esta operación.")), CLIENT_FORBIDDEN_ERROR],
        ["500 sin JSON", new Response("<html>", { status: 500 }), UPDATE_CLIENT_GENERIC_ERROR],
        ["error de red", new Error("offline"), UPDATE_CLIENT_GENERIC_ERROR],
    ])("%s -> mensaje legible", async (_label, res, expected) => {
        const result = await submitClientUpdate("c_1", {}, fetchReturning(res));
        expect(result).toEqual({ ok: false, message: expected });
    });

    it("nunca produce [object Object]", () => {
        expect(updateClientErrorMessage({ error: { code: 1, message: { x: 1 } } })).toBe(UPDATE_CLIENT_GENERIC_ERROR);
        expect(updateClientErrorMessage({ error: {} })).not.toMatch(/object Object/);
        expect(updateClientErrorMessage(null)).toBe(UPDATE_CLIENT_GENERIC_ERROR);
    });
});

describe("submitClientDelete", () => {
    it("DELETE a /api/clients/[id]; 204 -> ok=true", async () => {
        const fetchImpl = fetchReturning(new Response(null, { status: 204 }));
        expect(await submitClientDelete("c_1", fetchImpl)).toEqual({ ok: true });
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/clients/c_1");
        expect(init.method).toBe("DELETE");
    });

    it.each([
        ["409 períodos", jsonResponse(409, err("CONFLICT", "El cliente tiene períodos asociados y no se puede eliminar.")), DELETE_CLIENT_HAS_PERIODS_ERROR],
        ["404", jsonResponse(404, err("NOT_FOUND", "No encontrado.")), CLIENT_NOT_FOUND_ERROR],
        ["403", jsonResponse(403, err("FORBIDDEN", "No tenés permisos para esta operación.")), CLIENT_FORBIDDEN_ERROR],
        ["401", jsonResponse(401, err("UNAUTHENTICATED", "Necesitás iniciar sesión.")), "Necesitás iniciar sesión."],
        ["500 sin JSON", new Response("x", { status: 500 }), DELETE_CLIENT_GENERIC_ERROR],
        ["error de red", new Error("offline"), DELETE_CLIENT_GENERIC_ERROR],
    ])("%s -> mensaje legible", async (_label, res, expected) => {
        expect(await submitClientDelete("c_1", fetchReturning(res))).toEqual({ ok: false, message: expected });
    });

    it("cuerpo no reconocible -> genérico", () => {
        expect(deleteClientErrorMessage({ foo: "bar" })).toBe(DELETE_CLIENT_GENERIC_ERROR);
    });
});
