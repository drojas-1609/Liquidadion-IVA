import { describe, it, expect, vi } from "vitest";
import {
    applyArcaProposal,
    buildArcaProposal,
    createLookupSequencer,
    formatArcaAddress,
    requestCuitLookup,
    ARCA_GENERIC_ERROR,
    ARCA_NOT_CONFIGURED_MESSAGE,
    type ArcaPersonDTO,
    type CuitLookupOutcome,
} from "@/lib/arca-lookup-client";

// Datos SINTÉTICOS.
const CUIT = "30-44444444-0";
const OTHER = "20-11111111-2";
const person = (over: Partial<ArcaPersonDTO> = {}): ArcaPersonDTO => ({
    idPersona: "30444444440",
    name: "EMPRESA SINTETICA SA",
    personType: "JURIDICA",
    keyStatus: "ACTIVO",
    fiscalAddress: { street: "CALLE SINTETICA 123", locality: "LOCALIDAD DE PRUEBA", postalCode: "1000", provinceArcaId: "0", provinceName: "CABA" },
    taxes: [{ id: "30", description: "IVA", status: "AC" }],
    monotributoCategory: null,
    activities: [
        { code: "620100", description: "SERVICIOS SINTETICOS", nomenclator: "883", order: 1, period: "201801" },
        { code: "702092", description: "OTRA ACTIVIDAD SINTETICA", nomenclator: "883", order: 2, period: "201801" },
    ],
    notices: [],
    sourceDateTime: null,
    ...over,
});
const found = (p: ArcaPersonDTO = person()): Extract<CuitLookupOutcome, { status: "FOUND" }> => ({
    status: "FOUND",
    cuit: CUIT,
    source: "ARCA — Padrón",
    consultedAt: "2026-10-25T12:00:00.000Z",
    person: p,
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("requestCuitLookup", () => {
    it("envía el CUIT en el cuerpo (no en la URL)", async () => {
        const f = vi.fn(() => json({ status: "NOT_FOUND", cuit: CUIT }));
        expect(await requestCuitLookup(CUIT, f as unknown as typeof fetch)).toEqual({ status: "NOT_FOUND", cuit: CUIT });
        const [url, init] = (f.mock.calls[0] as unknown as [string, RequestInit]);
        expect(url).toBe("/api/arca/cuit-lookup");
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({ cuit: CUIT });
    });
    it("no configurada", async () => {
        const f = () => json({ status: "NOT_CONFIGURED", message: "x" });
        expect(await requestCuitLookup(CUIT, f as unknown as typeof fetch)).toEqual({ status: "NOT_CONFIGURED", message: ARCA_NOT_CONFIGURED_MESSAGE });
    });
    it("FOUND válido", async () => {
        const f = () => json(found());
        expect(await requestCuitLookup(CUIT, f as unknown as typeof fetch)).toEqual(found());
    });
    it("errores: mensaje del servidor, red caída o cuerpo inesperado", async () => {
        const e = () => json({ error: { code: "ARCA_TIMEOUT", message: "ARCA no respondió a tiempo." } }, 504);
        expect(await requestCuitLookup(CUIT, e as unknown as typeof fetch)).toEqual({ status: "ERROR", message: "ARCA no respondió a tiempo." });
        const down = () => Promise.reject(new TypeError("offline"));
        expect(await requestCuitLookup(CUIT, down as unknown as typeof fetch)).toEqual({ status: "ERROR", message: ARCA_GENERIC_ERROR });
        const weird = () => json({ status: "FOUND", cuit: CUIT });
        expect(await requestCuitLookup(CUIT, weird as unknown as typeof fetch)).toEqual({ status: "ERROR", message: ARCA_GENERIC_ERROR });
        const html = () => Promise.resolve(new Response("<html/>", { status: 502 }));
        expect(await requestCuitLookup(CUIT, html as unknown as typeof fetch)).toEqual({ status: "ERROR", message: ARCA_GENERIC_ERROR });
    });
});

describe("createLookupSequencer — respuestas fuera de orden y cambio de CUIT", () => {
    it("sólo acepta la última consulta", () => {
        const s = createLookupSequencer();
        const t1 = s.start();
        const t2 = s.start();
        expect(s.accepts(t1, CUIT, CUIT)).toBe(false);
        expect(s.accepts(t2, CUIT, CUIT)).toBe(true);
    });
    it("cancel invalida la consulta en curso", () => {
        const s = createLookupSequencer();
        const t = s.start();
        s.cancel();
        expect(s.accepts(t, CUIT, CUIT)).toBe(false);
    });
    it("descarta si el CUIT del formulario cambió; tolera distinto formato del mismo CUIT", () => {
        const s = createLookupSequencer();
        const t = s.start();
        expect(s.accepts(t, CUIT, OTHER)).toBe(false);
        expect(s.accepts(t, CUIT, "30-4444")).toBe(false);
        expect(s.accepts(t, CUIT, "30444444440")).toBe(true);
    });
});

describe("buildArcaProposal / applyArcaProposal", () => {
    it("formulario vacío: campos propuestos y preseleccionados; actividades NO preseleccionadas", () => {
        const p = buildArcaProposal(found(), { name: "", address: "" }, []);
        expect(p).toMatchObject({ cuit: CUIT, source: "ARCA — Padrón", consultedAt: "2026-10-25T12:00:00.000Z" });
        expect(p.fields.map((f) => [f.field, f.proposed, f.overwrites, f.selected])).toEqual([
            ["name", "EMPRESA SINTETICA SA", false, true],
            ["address", "CALLE SINTETICA 123, LOCALIDAD DE PRUEBA (CP 1000), CABA", false, true],
        ]);
        expect(p.activities.every((a) => !a.selected && !a.alreadyPresent)).toBe(true);
        expect(p.registrationInfo).toEqual(["IVA (AC)"]);
    });
    it("nunca propone teléfono, email, inscripción IIBB ni jurisdicciones", () => {
        const p = buildArcaProposal(found(), { name: "", address: "" }, []);
        const keys = p.fields.map((f) => f.field as string);
        expect(keys).not.toContain("phone");
        expect(keys).not.toContain("contactEmail");
        expect(JSON.stringify(p)).not.toMatch(/iibbRegistration|jurisdiction/i);
        const applied = applyArcaProposal(p, { fields: ["name", "address"], confirmOverwrite: true, activityCodes: ["620100"] });
        expect(Object.keys(applied.fields).sort()).toEqual(["address", "name"]);
    });
    it("preserva la edición manual: un valor distinto no se reemplaza sin confirmación", () => {
        const p = buildArcaProposal(found(), { name: "Nombre cargado a mano", address: "" }, []);
        const name = p.fields.find((f) => f.field === "name")!;
        expect(name).toMatchObject({ current: "Nombre cargado a mano", overwrites: true, selected: false });
        expect(applyArcaProposal(p, { fields: ["name", "address"], confirmOverwrite: false, activityCodes: [] }).fields).toEqual({
            address: "CALLE SINTETICA 123, LOCALIDAD DE PRUEBA (CP 1000), CABA",
        });
        expect(applyArcaProposal(p, { fields: ["name"], confirmOverwrite: true, activityCodes: [] }).fields).toEqual({ name: "EMPRESA SINTETICA SA" });
        expect(applyArcaProposal(p, { fields: [], confirmOverwrite: true, activityCodes: [] }).fields).toEqual({});
    });
    it("valores iguales no se proponen; datos ausentes no se inventan", () => {
        const p = buildArcaProposal(found(person({ fiscalAddress: null, activities: [], taxes: [] })), { name: "EMPRESA SINTETICA SA", address: "" }, []);
        expect(p.fields).toEqual([]);
        expect(p.activities).toEqual([]);
        expect(p.registrationInfo).toEqual([]);
    });
    it("actividades ya presentes no se duplican; sólo se agregan las elegidas", () => {
        const p = buildArcaProposal(found(), { name: "", address: "" }, ["620100"]);
        expect(p.activities.map((a) => [a.code, a.alreadyPresent])).toEqual([
            ["620100", true],
            ["702092", false],
        ]);
        const applied = applyArcaProposal(p, { fields: [], confirmOverwrite: false, activityCodes: ["620100", "702092"] });
        expect(applied.activities).toEqual([{ code: "702092", description: "OTRA ACTIVIDAD SINTETICA", nomenclatorReference: "883" }]);
    });
    it("monotributo se muestra como información, no se aplica", () => {
        const p = buildArcaProposal(found(person({ taxes: [], monotributoCategory: "A" })), { name: "", address: "" }, []);
        expect(p.registrationInfo).toEqual(["Monotributo: A"]);
    });
    it("formatArcaAddress omite partes vacías", () => {
        expect(formatArcaAddress(null)).toBe("");
        expect(formatArcaAddress({ street: "CALLE 1", locality: null, postalCode: null, provinceArcaId: null, provinceName: " " })).toBe("CALLE 1");
    });
});
