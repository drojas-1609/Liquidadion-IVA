import { describe, it, expect, vi } from "vitest";
import { requestCuitLookup, type ArcaPersonDTO } from "@/lib/arca-lookup-client";
import { CONDITION_NOT_DEDUCED, applyCounterpartyName, buildCounterpartyProposal, lookupCuitFrom } from "@/lib/invoice-counterparty-lookup";
import { cuit } from "./helpers/libro-iva-synth";

/** Respuestas SINTÉTICAS del servicio de consulta (sin ARCA ni credenciales). */
const CUIT = cuit("3071234567");
const person = (o: Partial<ArcaPersonDTO> = {}): ArcaPersonDTO => ({
    idPersona: CUIT, name: "PROVEEDOR SINTETICO SRL", personType: "JURIDICA", keyStatus: "ACTIVO", fiscalAddress: null,
    taxes: [{ id: "30", description: "IVA", status: "ACTIVO" }, { id: "10", description: "GANANCIAS SOCIEDADES", status: "ACTIVO" }],
    monotributoCategory: null, activities: [], notices: [], sourceDateTime: null, ...o,
});
const found = (o: Partial<ArcaPersonDTO> = {}) => ({ status: "FOUND" as const, cuit: `${CUIT.slice(0, 2)}-${CUIT.slice(2, 10)}-${CUIT[10]}`, source: "SINTETICO", consultedAt: "2027-10-20T12:00:00.000Z", person: person(o) });

describe("consulta de CUIT en ARCA para la contraparte de un comprobante", () => {
    it("sólo con documento 80 y CUIT válido; con otro documento no se ofrece", () => {
        expect(lookupCuitFrom(80, CUIT)).toBe(`${CUIT.slice(0, 2)}-${CUIT.slice(2, 10)}-${CUIT[10]}`);
        expect(lookupCuitFrom(80, CUIT.slice(0, 10) + String((Number(CUIT[10]) + 1) % 10))).toBeNull();
        for (const doc of [86, 96, 99, null]) expect(lookupCuitFrom(doc, CUIT)).toBeNull();
    });

    it("propone la denominación; con el campo vacío se aplica sin confirmación", () => {
        const p = buildCounterpartyProposal(found(), "");
        expect([p.proposedName, p.overwrites, p.sameAsCurrent]).toEqual(["PROVEEDOR SINTETICO SRL", false, false]);
        expect(applyCounterpartyName(p, false)).toBe("PROVEEDOR SINTETICO SRL");
    });

    it("nunca reemplaza en silencio lo ingresado: con otra denominación exige confirmación", () => {
        const p = buildCounterpartyProposal(found(), "Proveedor Sintético");
        expect(p.overwrites).toBe(true);
        expect(applyCounterpartyName(p, false)).toBeNull();
        expect(applyCounterpartyName(p, true)).toBe("PROVEEDOR SINTETICO SRL");
        // Igual salvo mayúsculas: no hay nada que aplicar.
        const same = buildCounterpartyProposal(found(), "proveedor sintetico srl");
        expect([same.sameAsCurrent, applyCounterpartyName(same, true)]).toEqual([true, null]);
    });

    it("la condición frente al IVA no se deduce: impuestos y monotributo sólo como información", () => {
        for (const o of [{}, { taxes: [], monotributoCategory: "A" }, { taxes: [{ id: "32", description: "IVA EXENTO", status: "ACTIVO" }] }]) {
            const p = buildCounterpartyProposal(found(o), "");
            expect(p.conditionNote).toBe(CONDITION_NOT_DEDUCED);
            expect(Object.keys(p)).not.toContain("vatConditionCode");
        }
        expect(buildCounterpartyProposal(found({ taxes: [], monotributoCategory: "A" }), "").registrationInfo).toContain("Monotributo: categoría A");
    });

    it("sin denominación informada no hay nada que aplicar", () => {
        const p = buildCounterpartyProposal(found({ name: null }), "X");
        expect([p.proposedName, p.overwrites, applyCounterpartyName(p, true)]).toEqual([null, false, null]);
    });

    it("usa el MISMO servicio de la ficha de clientes (POST /api/arca/cuit-lookup, CUIT en el cuerpo) y traduce sus respuestas", async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(found()), { status: 200 }));
        const out = await requestCuitLookup(CUIT, fetchImpl as unknown as typeof fetch);
        expect(fetchImpl).toHaveBeenCalledWith("/api/arca/cuit-lookup", expect.objectContaining({ method: "POST", body: JSON.stringify({ cuit: CUIT }) }));
        expect(out.status).toBe("FOUND");
        const notConfigured = vi.fn(async () => new Response(JSON.stringify({ status: "NOT_CONFIGURED" }), { status: 200 }));
        expect((await requestCuitLookup(CUIT, notConfigured as unknown as typeof fetch)).status).toBe("NOT_CONFIGURED");
        const limited = vi.fn(async () => new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Se alcanzó el cupo interno de consultas a ARCA del estudio." } }), { status: 429 }));
        expect(await requestCuitLookup(CUIT, limited as unknown as typeof fetch)).toEqual({ status: "ERROR", message: "Se alcanzó el cupo interno de consultas a ARCA del estudio." });
    });
});
