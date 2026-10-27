import { describe, it, expect } from "vitest";
import {
    activityKey,
    checkRateString,
    normalizeContactEmail,
    normalizeContactPhone,
    profileFieldLabel,
    summarizeStoredProfile,
    unconfirmedRemovals,
    validateIibbProfile,
} from "@/lib/client-profile";
import { parseRate } from "@/lib/validation/decimal";
import { IIBB_REGISTRATION_LABEL, IIBB_REGISTRATIONS, IIBB_REGISTRATION_NATURE } from "@/lib/iibb/registration";
import { JURISDICTIONS, isJurisdictionCode } from "@/lib/iibb/jurisdictions";

const act = (over: Record<string, unknown> = {}) => ({ nomenclator: "NAES", code: "620100", description: "Servicios de prueba", rates: [], ...over });

describe("contactos", () => {
    it.each(["contacto@estudio.test", "  Persona.Uno+ref@sub.dominio.test  ", "a@b.co"])("email válido: %s", (v) => {
        expect(normalizeContactEmail(v)).toEqual({ ok: true, value: v.trim() });
    });
    it.each(["", "   ", "sin-arroba", "a@b", "a @b.test", "a@b..test", "@b.test", 42, null])("email inválido: %s", (v) => {
        expect(normalizeContactEmail(v).ok).toBe(false);
    });
    it("email demasiado largo", () => {
        expect(normalizeContactEmail(`${"a".repeat(250)}@b.test`).ok).toBe(false);
    });
    it.each(["+54 11 5555-0100", "(011) 4555-0100", "+1 (212) 555-0100", "011.4555.0100", "+44 20 7946 0958", "1155550100"])(
        "teléfono válido (formatos nacionales e internacionales): %s",
        (v) => {
            const r = normalizeContactPhone(v);
            expect(r.ok).toBe(true);
        },
    );
    it.each(["", "abc", "11-5555-01OO", "++54 11 5555", "54+11 5555 0100", "12345", "+1234567890123456", 1155550100])("teléfono inválido: %s", (v) => {
        expect(normalizeContactPhone(v).ok).toBe(false);
    });
    it("el teléfono colapsa espacios internos repetidos sin alterar dígitos", () => {
        expect(normalizeContactPhone(" +54  11   5555-0100 ")).toEqual({ ok: true, value: "+54 11 5555-0100" });
    });
    it("etiquetas legibles de los campos nuevos", () => {
        expect(profileFieldLabel("phone")).toBe("Teléfono");
        expect(profileFieldLabel("contactEmail")).toBe("Email de contacto");
        expect(profileFieldLabel("iibb.activities[0].code")).toBe("Ingresos Brutos");
        expect(profileFieldLabel("cuit")).toBeNull();
    });
});

describe("catálogos", () => {
    it("opciones de inscripción EXACTAS y en orden", () => {
        expect(IIBB_REGISTRATIONS.map((r) => IIBB_REGISTRATION_LABEL[r])).toEqual([
            "Local",
            "Simplificado",
            "Exento",
            "No Inscripto",
            "Convenio Multilateral",
        ]);
    });
    it("distingue régimen, tratamiento y situación sin cambiar las opciones", () => {
        expect(IIBB_REGISTRATION_NATURE).toEqual({
            LOCAL: "REGIMEN",
            SIMPLIFICADO: "REGIMEN",
            CONVENIO_MULTILATERAL: "REGIMEN",
            EXENTO: "TRATAMIENTO",
            NO_INSCRIPTO: "SITUACION",
        });
    });
    it("24 jurisdicciones con códigos 901..924 únicos y nombres no vacíos", () => {
        expect(JURISDICTIONS.map((j) => j.code)).toEqual(Array.from({ length: 24 }, (_, i) => String(901 + i)));
        expect(new Set(JURISDICTIONS.map((j) => j.name)).size).toBe(24);
        expect(isJurisdictionCode("925")).toBe(false);
        expect(isJurisdictionCode(901)).toBe(false);
    });
});

describe("validateIibbProfile — inscripción y jurisdicciones", () => {
    it("sin inscripción: válido sin jurisdicciones (cliente sin clasificar)", () => {
        expect(validateIibbProfile({})).toMatchObject({ ok: true, value: { registration: null, jurisdictions: [], activities: [] } });
        expect(validateIibbProfile({ registration: "" })).toMatchObject({ ok: true, value: { registration: null } });
    });
    it("sin inscripción no se registran jurisdicciones", () => {
        expect(validateIibbProfile({ jurisdictions: [{ code: "901" }] })).toMatchObject({ ok: false, field: "iibb.registration" });
    });
    it("inscripción inexistente -> rechazada", () => {
        expect(validateIibbProfile({ registration: "MONOTRIBUTO" })).toMatchObject({ ok: false, field: "iibb.registration" });
    });
    it.each(["LOCAL", "SIMPLIFICADO"])("%s: exactamente una jurisdicción", (registration) => {
        expect(validateIibbProfile({ registration, jurisdictions: [{ code: "904" }] }).ok).toBe(true);
        expect(validateIibbProfile({ registration, jurisdictions: [] })).toMatchObject({ ok: false, field: "iibb.jurisdictions" });
        expect(validateIibbProfile({ registration, jurisdictions: [{ code: "904" }, { code: "921" }] })).toMatchObject({
            ok: false,
            field: "iibb.jurisdictions",
        });
        expect(validateIibbProfile({ registration, jurisdictions: [{ code: "904", headquarters: true }] })).toMatchObject({
            ok: false,
            field: "iibb.headquarters",
        });
    });
    it("Convenio Multilateral: selección múltiple con UNA sede incluida", () => {
        const r = validateIibbProfile({
            registration: "CONVENIO_MULTILATERAL",
            jurisdictions: [{ code: "901", headquarters: true }, { code: "902" }, { code: "921" }],
        });
        expect(r).toMatchObject({ ok: true });
        if (r.ok) expect(r.value.jurisdictions.filter((j) => j.headquarters).map((j) => j.code)).toEqual(["901"]);
    });
    it("Convenio Multilateral sin mínimo de dos jurisdicciones (transición)", () => {
        expect(validateIibbProfile({ registration: "CONVENIO_MULTILATERAL", jurisdictions: [{ code: "904", headquarters: true }] }).ok).toBe(true);
    });
    it("Convenio Multilateral sin sede, con dos sedes o sin jurisdicciones -> rechazado", () => {
        const cm = (jurisdictions: unknown[]) => validateIibbProfile({ registration: "CONVENIO_MULTILATERAL", jurisdictions });
        expect(cm([{ code: "901" }, { code: "902" }])).toMatchObject({ ok: false, field: "iibb.headquarters" });
        expect(cm([{ code: "901", headquarters: true }, { code: "902", headquarters: true }])).toMatchObject({ ok: false, field: "iibb.headquarters" });
        expect(cm([])).toMatchObject({ ok: false, field: "iibb.jurisdictions" });
    });
    it("Exento: una o varias jurisdicciones, sin sede", () => {
        expect(validateIibbProfile({ registration: "EXENTO", jurisdictions: [{ code: "901" }] }).ok).toBe(true);
        expect(validateIibbProfile({ registration: "EXENTO", jurisdictions: [{ code: "901" }, { code: "913" }] }).ok).toBe(true);
        expect(validateIibbProfile({ registration: "EXENTO", jurisdictions: [] }).ok).toBe(false);
    });
    it("No Inscripto: jurisdicciones de actividad opcionales, sin sede", () => {
        expect(validateIibbProfile({ registration: "NO_INSCRIPTO", jurisdictions: [] }).ok).toBe(true);
        expect(validateIibbProfile({ registration: "NO_INSCRIPTO", jurisdictions: [{ code: "905" }, { code: "906" }] }).ok).toBe(true);
        expect(validateIibbProfile({ registration: "NO_INSCRIPTO", jurisdictions: [{ code: "905", headquarters: true }] }).ok).toBe(false);
    });
    it("jurisdicción duplicada, inexistente o con formato ajeno -> rechazada", () => {
        expect(validateIibbProfile({ registration: "EXENTO", jurisdictions: [{ code: "901" }, { code: "901" }] }).ok).toBe(false);
        expect(validateIibbProfile({ registration: "EXENTO", jurisdictions: [{ code: "999" }] }).ok).toBe(false);
        expect(validateIibbProfile({ registration: "EXENTO", jurisdictions: [{ code: 901 }] }).ok).toBe(false);
        expect(validateIibbProfile({ registration: "EXENTO", jurisdictions: "901" }).ok).toBe(false);
    });
});

describe("validateIibbProfile — actividades y alícuotas", () => {
    const base = { registration: "CONVENIO_MULTILATERAL", jurisdictions: [{ code: "901", headquarters: true }, { code: "902" }] };

    it("varias actividades con alícuotas distintas por jurisdicción", () => {
        const r = validateIibbProfile({
            ...base,
            activities: [
                act({ code: "620100", rates: [{ jurisdiction: "901", rate: "3.5" }, { jurisdiction: "902", rate: "4" }] }),
                act({ code: "702092", nomenclator: "ARCA", rates: [{ jurisdiction: "901", rate: "5" }] }),
            ],
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            // Sin tratamiento ni origen en la entrada: RATE y sin origen registrado.
            expect(r.value.activities[0].rates).toEqual([
                { jurisdiction: "901", rate: "3.5", treatment: "RATE", origin: null, ruleRef: null },
                { jurisdiction: "902", rate: "4", treatment: "RATE", origin: null, ruleRef: null },
            ]);
            expect(r.value.activities[1].rates).toEqual([{ jurisdiction: "901", rate: "5", treatment: "RATE", origin: null, ruleRef: null }]);
        }
    });
    it("distingue 0 explícito de sin informar", () => {
        const r = validateIibbProfile({
            ...base,
            activities: [act({ rates: [{ jurisdiction: "901", rate: "0" }, { jurisdiction: "902", rate: null }] })],
        });
        expect(r.ok && r.value.activities[0].rates).toEqual([
            { jurisdiction: "901", rate: "0", treatment: "RATE", origin: null, ruleRef: null },
            { jurisdiction: "902", rate: null, treatment: "RATE", origin: null, ruleRef: null },
        ]);
        const empty = validateIibbProfile({ ...base, activities: [act({ rates: [{ jurisdiction: "901", rate: "" }] })] });
        expect(empty.ok && empty.value.activities[0].rates[0].rate).toBeNull();
    });
    it("alícuota fuera de rango, con signo, coma o número -> rechazada", () => {
        for (const rate of ["101", "-1", "3,5", "1e2", "3.1234567"]) {
            expect(validateIibbProfile({ ...base, activities: [act({ rates: [{ jurisdiction: "901", rate }] })] }).ok, rate).toBe(false);
        }
        expect(validateIibbProfile({ ...base, activities: [act({ rates: [{ jurisdiction: "901", rate: 3 }] })] }).ok).toBe(false);
    });
    it("alícuota para una jurisdicción no registrada del cliente o duplicada -> rechazada", () => {
        expect(validateIibbProfile({ ...base, activities: [act({ rates: [{ jurisdiction: "904", rate: "1" }] })] })).toMatchObject({ ok: false });
        expect(
            validateIibbProfile({ ...base, activities: [act({ rates: [{ jurisdiction: "901", rate: "1" }, { jurisdiction: "901", rate: "2" }] })] }).ok,
        ).toBe(false);
    });
    it("actividad duplicada (mismo nomenclador y código, sin importar mayúsculas) -> rechazada", () => {
        expect(validateIibbProfile({ ...base, activities: [act({ code: "A1" }), act({ code: "a1" })] }).ok).toBe(false);
    });
    it("el mismo código en nomencladores distintos NO es duplicado ni equivalente", () => {
        expect(validateIibbProfile({ ...base, activities: [act({ nomenclator: "ARCA" }), act({ nomenclator: "NAES" })] }).ok).toBe(true);
    });
    it("nomenclador provincial exige su jurisdicción; los demás no la admiten", () => {
        expect(validateIibbProfile({ ...base, activities: [act({ nomenclator: "PROVINCIAL" })] }).ok).toBe(false);
        expect(validateIibbProfile({ ...base, activities: [act({ nomenclator: "PROVINCIAL", nomenclatorJurisdiction: "904" })] }).ok).toBe(true);
        expect(validateIibbProfile({ ...base, activities: [act({ nomenclator: "NAES", nomenclatorJurisdiction: "904" })] }).ok).toBe(false);
    });
    it("nomenclador OTRO exige referencia; código y descripción requeridos", () => {
        expect(validateIibbProfile({ ...base, activities: [act({ nomenclator: "OTRO" })] }).ok).toBe(false);
        expect(validateIibbProfile({ ...base, activities: [act({ nomenclator: "OTRO", nomenclatorReference: "Nomenclador X" })] }).ok).toBe(true);
        expect(validateIibbProfile({ ...base, activities: [act({ code: "" })] }).ok).toBe(false);
        expect(validateIibbProfile({ ...base, activities: [act({ code: "62 01" })] }).ok).toBe(false);
        expect(validateIibbProfile({ ...base, activities: [act({ description: "  " })] }).ok).toBe(false);
    });
    it("actividades sin inscripción ni jurisdicciones: permitidas sin alícuotas", () => {
        expect(validateIibbProfile({ activities: [act()] }).ok).toBe(true);
    });
});

describe("checkRateString = mismas reglas que parseRate (servidor)", () => {
    it.each(["0", "0.0", "3", "3.5", "3.123456", "100", "100.000000", "007.5", "99.999999", "101", "100.000001", "-1", "1e2", "3,5", "3.1234567", "", " 3", ".5", "5."])(
        "%s",
        (s) => {
            // validateIibbProfile recorta antes de validar, como preCheck de parseRate.
            expect(checkRateString(s.trim()) === null).toBe(parseRate(s).ok);
        },
    );
});

describe("unconfirmedRemovals — nada se borra en silencio", () => {
    const next = (over: Record<string, unknown>) => {
        const r = validateIibbProfile({ registration: "EXENTO", jurisdictions: [{ code: "901" }], ...over });
        if (!r.ok) throw new Error(r.error);
        return r.value;
    };
    const KEY = activityKey({ nomenclator: "NAES", nomenclatorJurisdiction: "", code: "620100" });
    const OTHER = activityKey({ nomenclator: "ARCA", nomenclatorJurisdiction: "", code: "702092" });
    // Guardado: 901 (KEY), 902 (KEY y OTHER), 903 sin asociaciones.
    const stored = summarizeStoredProfile({
        jurisdictions: [{ code: "901" }, { code: "902" }, { code: "903" }],
        activities: [
            { nomenclator: "NAES", nomenclatorJurisdiction: "", code: "620100", rates: [{ jurisdiction: "901" }, { jurisdiction: "902" }] },
            { nomenclator: "ARCA", nomenclatorJurisdiction: "", code: "702092", rates: [{ jurisdiction: "902" }] },
        ],
    });

    it("resumen en ambas direcciones, ordenado", () => {
        expect(stored).toEqual({
            associationsByJurisdiction: { "901": [KEY], "902": [OTHER, KEY].sort(), "903": [] },
            activities: { [KEY]: ["901", "902"], [OTHER]: ["902"] },
        });
    });
    it("quitar jurisdicciones con asociaciones exige confirmarlas con el conjunto exacto; sin asociaciones, no", () => {
        const base = { activities: [act(), { ...act(), nomenclator: "ARCA", code: "702092" }] };
        expect(unconfirmedRemovals(stored, next(base)).jurisdictions).toEqual(["902"]);
        const exact = [{ code: "902", associations: [KEY, OTHER] }];
        expect(unconfirmedRemovals(stored, next({ ...base, confirmRemovedJurisdictions: exact })).jurisdictions).toEqual([]);
        // Confirmación de un conjunto distinto (le falta una asociación guardada): no vale.
        expect(unconfirmedRemovals(stored, next({ ...base, confirmRemovedJurisdictions: [{ code: "902", associations: [KEY] }] })).jurisdictions).toEqual(["902"]);
        // Ni con una asociación de más.
        const extra = [{ code: "902", associations: [KEY, OTHER, "NAES||999999"] }];
        expect(unconfirmedRemovals(stored, next({ ...base, confirmRemovedJurisdictions: extra })).jurisdictions).toEqual(["902"]);
    });
    it("quitar una actividad guardada exige confirmarla con sus jurisdicciones exactas", () => {
        const j902 = [{ code: "902", associations: [KEY, OTHER] }];
        const keep = { activities: [{ ...act(), nomenclator: "ARCA", code: "702092" }], confirmRemovedJurisdictions: j902 };
        expect(unconfirmedRemovals(stored, next(keep)).activities).toEqual([KEY]);
        expect(unconfirmedRemovals(stored, next({ ...keep, confirmRemovedActivities: [{ key: KEY, jurisdictions: ["901"] }] })).activities).toEqual([KEY]);
        expect(unconfirmedRemovals(stored, next({ ...keep, confirmRemovedActivities: [{ key: KEY, jurisdictions: ["902", "901"] }] })).activities).toEqual([]);
    });
    it("una actividad guardada sin alícuotas también exige confirmación (conjunto vacío)", () => {
        const s = summarizeStoredProfile({ jurisdictions: [{ code: "901" }], activities: [{ nomenclator: "NAES", nomenclatorJurisdiction: "", code: "620100", rates: [] }] });
        expect(unconfirmedRemovals(s, next({})).activities).toEqual([KEY]);
        expect(unconfirmedRemovals(s, next({ confirmRemovedActivities: [{ key: KEY, jurisdictions: [] }] })).activities).toEqual([]);
    });
    it.each([
        [{ confirmRemovedJurisdictions: ["902"] }, "iibb.confirmRemovedJurisdictions"],
        [{ confirmRemovedJurisdictions: [{ code: "999", associations: [] }] }, "iibb.confirmRemovedJurisdictions"],
        [{ confirmRemovedJurisdictions: [{ code: "902", associations: [] }, { code: "902", associations: [] }] }, "iibb.confirmRemovedJurisdictions"],
        [{ confirmRemovedJurisdictions: [{ code: "902", associations: "x" }] }, "iibb.confirmRemovedJurisdictions"],
        [{ confirmRemovedActivities: ["NAES||620100"] }, "iibb.confirmRemovedActivities"],
        [{ confirmRemovedActivities: [{ key: "", jurisdictions: [] }] }, "iibb.confirmRemovedActivities"],
        [{ confirmRemovedActivities: [{ key: "k", jurisdictions: ["999"] }] }, "iibb.confirmRemovedActivities"],
    ])("confirmaciones mal formadas -> 422 (%j)", (over, field) => {
        const r = validateIibbProfile({ registration: "EXENTO", jurisdictions: [{ code: "901" }], ...over });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.field).toBe(field);
    });
});
