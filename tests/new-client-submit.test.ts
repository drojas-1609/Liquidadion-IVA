import { describe, it, expect, vi } from "vitest";
import {
    submitNewClient,
    newClientErrorMessage,
    NEW_CLIENT_GENERIC_ERROR,
    NEW_CLIENT_DUPLICATE_CUIT_ERROR,
} from "@/lib/new-client-submit";

const FORM = { name: "Alfa SA", cuit: "20-12345678-6", condition: "Monotributo" };

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

async function failureMessage(res: Response | Error): Promise<string> {
    const result = await submitNewClient(FORM, fetchReturning(res));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    return result.message;
}

describe("submitNewClient", () => {
    it("alta exitosa: POST JSON a /api/clients y ok=true", async () => {
        const fetchImpl = fetchReturning(jsonResponse(201, { id: "c_1", ...FORM }));
        const result = await submitNewClient(FORM, fetchImpl);

        expect(result).toEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/clients");
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({ "Content-Type": "application/json" });
        expect(JSON.parse(init.body as string)).toEqual(FORM);
    });

    it("409 CONFLICT estructurado muestra el mensaje de CUIT duplicado", async () => {
        const msg = await failureMessage(
            jsonResponse(409, { error: { code: "CONFLICT", message: "Ya existe un registro con esos datos." } }),
        );
        expect(msg).toBe(NEW_CLIENT_DUPLICATE_CUIT_ERROR);
        expect(msg).toBe("Ya existe un cliente con ese CUIT en la organización.");
    });

    it("error estructurado no-CONFLICT muestra error.message", async () => {
        const msg = await failureMessage(
            jsonResponse(403, { error: { code: "FORBIDDEN", message: "No tenés permisos para esta operación." } }),
        );
        expect(msg).toBe("No tenés permisos para esta operación.");
    });

    it("error estructurado 422 con field conserva el prefijo del campo", async () => {
        const msg = await failureMessage(
            jsonResponse(422, {
                error: { code: "UNPROCESSABLE_ENTITY", message: "CUIT inválido" },
                field: "cuit",
            }),
        );
        expect(msg).toBe("cuit: CUIT inválido");
    });

    it("error como string sigue funcionando", async () => {
        expect(await failureMessage(jsonResponse(400, { error: "Datos inválidos" }))).toBe("Datos inválidos");
        expect(await failureMessage(jsonResponse(422, { error: "Requerido", field: "name" }))).toBe(
            "name: Requerido",
        );
    });

    it("respuesta no JSON usa el mensaje genérico", async () => {
        const res = new Response("<html>Bad Gateway</html>", { status: 502 });
        expect(await failureMessage(res)).toBe(NEW_CLIENT_GENERIC_ERROR);
    });

    it("error de red usa el mensaje genérico", async () => {
        expect(await failureMessage(new TypeError("Failed to fetch"))).toBe(NEW_CLIENT_GENERIC_ERROR);
    });

    it.each([
        ["null", null],
        ["array", [1, 2]],
        ["sin error", { ok: false }],
        ["error numérico", { error: 42 }],
        ["error vacío", { error: "" }],
        ["error objeto sin message", { error: { code: "INTERNAL" } }],
        ["message no string", { error: { code: "INTERNAL", message: { detail: "x" } } }],
        ["error objeto anidado", { error: { nested: { deep: true } } }],
    ])("respuesta inesperada (%s) usa el mensaje genérico", async (_label, body) => {
        expect(await failureMessage(jsonResponse(500, body))).toBe(NEW_CLIENT_GENERIC_ERROR);
    });
});

describe("newClientErrorMessage nunca produce [object Object]", () => {
    const bodies: unknown[] = [
        { error: { code: "CONFLICT", message: "x" } },
        { error: { code: "INTERNAL", message: "Error interno." } },
        { error: { message: { a: 1 } } },
        { error: { code: { a: 1 } } },
        { error: {} },
        { error: [] },
        { error: "texto", field: { a: 1 } },
        { error: { message: "m" }, field: { a: 1 } },
        {},
        null,
        undefined,
        "string suelto",
        123,
    ];

    it.each(bodies.map((b) => [JSON.stringify(b) ?? String(b), b]))("%s", (_label, body) => {
        const msg = newClientErrorMessage(body);
        expect(typeof msg).toBe("string");
        expect(msg).not.toContain("[object Object]");
        expect(msg.trim()).not.toBe("");
    });
});
