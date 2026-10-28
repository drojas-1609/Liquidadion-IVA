import { describe, it, expect } from "vitest";
import {
    activityFieldKey,
    collectFormErrors,
    domIdFor,
    keyForApiField,
    rateFieldKey,
    serverErrorToForm,
    snapshotOf,
    activityPayload,
    type DraftActivity,
    type DraftForm,
} from "@/lib/client-form-errors";
import { validateIibbProfile } from "@/lib/client-profile";
import { jurisdictionLabel } from "@/lib/iibb/jurisdictions";

const row = (uid: number, over: Partial<DraftActivity> = {}): DraftActivity => ({
    uid,
    nomenclator: "NAES",
    nomenclatorJurisdiction: "",
    nomenclatorReference: "",
    code: `62010${uid}`,
    description: `Actividad ${uid}`,
    origin: "MANUAL",
    catalogId: null,
    catalogVersion: null,
    rates: {},
    ...over,
});
const form = (over: Partial<DraftForm> = {}): DraftForm => ({
    mode: "create",
    fields: { name: "Cliente de prueba", cuit: "30-99999917-0", condition: "Responsable Inscripto", address: "", phone: "+54 11 5555-0100", contactEmail: "a@estudio.test", defaultIibbRate: "3" },
    initialContacts: { phone: "", contactEmail: "" },
    registration: "CONVENIO_MULTILATERAL",
    jurisdictions: [
        { code: "901", headquarters: true },
        { code: "921", headquarters: false },
    ],
    activities: [],
    ...over,
});
const collect = (d: DraftForm) => collectFormErrors(d, jurisdictionLabel);
const keys = (d: DraftForm) => collect(d).map((e) => e.key);

describe("errores por campo (todos, no sólo el primero)", () => {
    it("formulario válido: sin errores", () => {
        expect(collect(form({ activities: [row(1)] }))).toEqual([]);
    });
    it("campos generales y contactos", () => {
        expect(keys(form({ fields: { ...form().fields, name: " ", cuit: "30-99999917-1", phone: "12", contactEmail: "x" } }))).toEqual(["name", "cuit", "phone", "contactEmail"]);
    });
    it("alícuota del cálculo actual: obligatoria y con las reglas de la API (sin signo, máximo de decimales)", () => {
        expect(keys(form({ fields: { ...form().fields, defaultIibbRate: "" } }))).toEqual(["defaultIibbRate"]);
        expect(keys(form({ fields: { ...form().fields, defaultIibbRate: "-1" } }))).toEqual(["defaultIibbRate"]);
        expect(keys(form({ fields: { ...form().fields, defaultIibbRate: "3.1234567" } }))).toEqual(["defaultIibbRate"]);
        expect(keys(form({ fields: { ...form().fields, defaultIibbRate: "3.5" } }))).toEqual([]);
        expect(keys(form({ fields: { ...form().fields, defaultIibbRate: "0" } }))).toEqual([]);
    });
    it("histórico sin contactos: puede seguir pendiente; vaciar uno cargado es error", () => {
        const hist = form({ mode: "edit", fields: { ...form().fields, phone: "", contactEmail: "" } });
        expect(keys(hist)).toEqual([]);
        const emptied = form({ mode: "edit", initialContacts: { phone: "+54 11 5555-0100", contactEmail: "" }, fields: { ...form().fields, phone: "", contactEmail: "" } });
        expect(collect(emptied)).toEqual([expect.objectContaining({ key: "phone", message: expect.stringMatching(/no se puede vaciar/) })]);
    });
    it("perfil: sede de CM", () => {
        expect(keys(form({ jurisdictions: [{ code: "901", headquarters: false }] }))).toEqual(["headquarters"]);
    });
    it("varias filas con errores distintos, cada uno en SU fila (por uid) y en su campo", () => {
        const d = form({
            activities: [
                row(7, { code: "" }),
                row(3, { description: " " }),
                row(9, { rates: { "901": { associated: true, rate: "101", treatment: "RATE", origin: "STUDIO_MANUAL", ruleRef: null } } }),
            ],
        });
        expect(keys(d)).toEqual([activityFieldKey(7, "code"), activityFieldKey(3, "description"), rateFieldKey(9, "901")]);
        const labels = collect(d).map((e) => e.label);
        expect(labels).toEqual(["Actividad 1: código", "Actividad 2 (620103): descripción", "Actividad 3 (620109): alícuota en 901 · Ciudad Autónoma de Buenos Aires"]);
    });
    it("varias alícuotas inválidas de la misma fila: un error por jurisdicción", () => {
        const d = form({
            activities: [
                row(4, {
                    rates: {
                        "901": { associated: true, rate: "-1", treatment: "RATE", origin: "STUDIO_MANUAL", ruleRef: null },
                        "921": { associated: true, rate: "3", treatment: "EXEMPT", origin: "STUDIO_MANUAL", ruleRef: null },
                    },
                }),
            ],
        });
        // La exención con tasa no viaja (el formulario manda rate null): sólo queda el error de 901.
        expect(keys(d)).toEqual([rateFieldKey(4, "901")]);
    });
    it("duplicado: el error queda en la SEGUNDA fila", () => {
        expect(keys(form({ activities: [row(1, { code: "620100" }), row(2, { code: "620100" })] }))).toEqual([activityFieldKey(2, "code")]);
    });
    it("claves estables: agregar, quitar o reordenar filas no cambia la clave de una fila", () => {
        const bad = row(5, { description: "" });
        const a = keys(form({ activities: [row(1), bad] }));
        const b = keys(form({ activities: [bad, row(1), row(8)] }));
        const c = keys(form({ activities: [row(8), bad] }));
        expect(a).toEqual([activityFieldKey(5, "description")]);
        expect(b).toEqual(a);
        expect(c).toEqual(a);
    });
    it("equivalencia con el validador autoritativo: sin errores por campo <=> el perfil completo valida", () => {
        const samples: DraftForm[] = [
            form({ activities: [row(1)] }),
            form({ activities: [row(1, { code: "" })] }),
            form({ activities: [row(1), row(2, { code: "620101" })] }),
            form({ activities: [row(1, { nomenclator: "PROVINCIAL" })] }),
            form({ activities: [row(1, { nomenclator: "OTRO" })] }),
            form({ activities: [row(1, { rates: { "904": { associated: true, rate: "1", treatment: "RATE", origin: "STUDIO_MANUAL", ruleRef: null } } })] }),
            form({ activities: [row(1, { origin: "CATALOG" })] }),
            form({ registration: "LOCAL" }),
            form({ registration: "", jurisdictions: [] }),
        ];
        for (const d of samples) {
            const sel = d.jurisdictions.map((j) => j.code);
            const full = validateIibbProfile({ registration: d.registration || null, jurisdictions: d.jurisdictions, activities: d.activities.map((a) => activityPayload(a, sel)) });
            const iibbErrors = collect(d).filter((e) => !["name", "cuit", "condition", "phone", "contactEmail"].includes(e.key));
            expect(iibbErrors.length === 0, JSON.stringify(d.activities)).toBe(full.ok);
        }
    });
});

describe("errores del servidor -> campo estable con la foto de lo enviado", () => {
    const sel = ["901", "921"];
    const sent = [
        row(11, { rates: { "921": { associated: true, rate: "1", treatment: "RATE", origin: "STUDIO_MANUAL", ruleRef: null }, "901": { associated: true, rate: "2", treatment: "RATE", origin: "STUDIO_MANUAL", ruleRef: null } } }),
        row(4),
    ];
    const snap = snapshotOf(sent, sel);

    it("índices de la API se traducen por uid y jurisdicción enviados", () => {
        expect(keyForApiField("iibb.activities[1].code", snap)).toBe(activityFieldKey(4, "code"));
        expect(keyForApiField("iibb.activities[0].rates[1]", snap)).toBe(rateFieldKey(11, snap.rateJurisdictions[0][1]));
        expect(keyForApiField("iibb.activities[0].catalogId", snap)).toBe(activityFieldKey(11, "origin"));
        expect(keyForApiField("phone", snap)).toBe("phone");
        expect(keyForApiField("iibb.headquarters", snap)).toBe("headquarters");
        expect(keyForApiField("iibb.jurisdictions[0]", snap)).toBe("jurisdictions");
        expect(keyForApiField("iibb.activities[9].code", snap)).toBe("activities");
        expect(keyForApiField("body", snap)).toBeNull();
        expect(keyForApiField(undefined, snap)).toBeNull();
    });
    it("aunque el formulario se reordene después del envío, el error apunta a la fila enviada", () => {
        const now = [row(4), sent[0]]; // reordenado
        const r = serverErrorToForm({ message: "Ingresos Brutos: actividad duplicada", field: "iibb.activities[1].code", fieldMessage: "actividad duplicada" }, snap, now, jurisdictionLabel);
        expect(r).toEqual({ kind: "validation", message: "Ingresos Brutos: actividad duplicada", errors: [{ key: activityFieldKey(4, "code"), label: "Actividad 1 (620104): código", message: "actividad duplicada" }] });
    });
    it("distingue conflicto de versión, error de validación y error general", () => {
        expect(serverErrorToForm({ message: "Otra persona modificó...", stale: true }, snap, sent, jurisdictionLabel).kind).toBe("conflict");
        expect(serverErrorToForm({ message: "Error al actualizar el cliente" }, snap, sent, jurisdictionLabel)).toEqual({ kind: "general", errors: [], message: "Error al actualizar el cliente" });
        expect(serverErrorToForm({ message: "CUIT: inválido", field: "cuit", fieldMessage: "inválido" }, snap, sent, jurisdictionLabel).kind).toBe("validation");
    });
    it("ids de DOM estables y seguros", () => {
        expect(domIdFor(":r1:", rateFieldKey(11, "901"))).toBe(":r1:-f-act_11_rate_901");
        expect(domIdFor(":r1:", "phone")).toBe(":r1:-f-phone");
    });
});
