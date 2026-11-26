/**
 * Conjuntos de reglas de alícuotas 2026 de Corrientes (905) y Santa Cruz (920),
 * generados de forma REPRODUCIBLE desde el texto (`pdftotext -layout`) de las
 * tablas oficiales:
 *
 *  - Corrientes: Anexo I de la RG DGR 293/2025 (nomenclador NAES con alícuota,
 *    mínimo mensual y régimen). Los mínimos se cotejan con el art. 10 A de la
 *    Ley Tarifaria 6249 (mínimo según la alícuota).
 *  - Santa Cruz: Anexo I de la Ley Impositiva 3485 según el texto de referencia
 *    que publica ASIP (posterior a la Ley 3760, B.O. 25/11/2021; fecha de
 *    actualización no acreditada por ASIP). Usa los códigos de AFIP (F-883):
 *    catálogo de ARCA. Mínimos: art. 7 de la Ley 3485 (sólo 551010 y 939030).
 *
 * Decisiones del estudio (Diego Rojas, 24/11/2026):
 *  - Corrientes: «Por Menor», «Por Mayor» y «Comisión» son alternativas que
 *    exigen un hecho declarado; el «Régimen General» exige el hecho contrario.
 *  - Mínimos: se informan por actividad; la liquidación aplica el mayor mínimo
 *    contra el impuesto total del mes.
 *
 * Queda RETENIDO (sin sugerencia): categorías con mínimo por habitación, cama o
 * sala (hoteles, transitorios, sanatorios, servicios fúnebres: Ley Tarifaria
 * art. 10 B a D). Los códigos que no están en el catálogo NAES no generan regla.
 *
 *   pdftotext -layout <anexo>.pdf anexo.txt
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- ctes-2026 \
 *     --pdf <anexo>.pdf --text anexo.txt --catalog data/activity-catalogs/naes-rg-ca-19-2025.json \
 *     --consulted AAAA-MM-DD --out data/iibb-rate-rules/corrientes-rg-293-2025.json
 *   (sc-2026: --pdf, --text del Anexo I de ASIP, --catalog data/activity-catalogs/clae-rg-afip-3537-2013.json)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sha256Hex } from "../../lib/activity-catalog/checksum";
import type { CatalogFile } from "../../lib/activity-catalog/types";
import type { RateRule, RateRuleSet, RuleCondition } from "../../lib/iibb-rates/types";
import { validateRuleSet } from "../../lib/iibb-rates/validate";
import { RULES_REVIEW_LEVELS, pendingReview } from "../../lib/activity-catalog/review";
import { parseArgs, required } from "../activity-catalogs/import";

const pad = (c: string) => c.padStart(6, "0");
/** "2,90%" | "2.9" | "5%" → "2.9" (sin ceros sobrantes). */
export function normRate(s: string): string {
    const v = s.replace("%", "").replace(",", ".").trim();
    if (!/^\d{1,3}(\.\d{1,4})?$/.test(v)) throw new Error(`alícuota ilegible: ${s}`);
    return String(Number(v));
}

/* ------------------------------ Corrientes ------------------------------ */

export const CTES_ID = "corrientes-rg-293-2025";
const CTES_URL = "https://strapidgrcorrientes.s3.amazonaws.com/ANEXO_1_Resolucion_General_N_293_2025_cae33370f1.pdf";

/** Ley Tarifaria 6249, art. 10 A: mínimo mensual según la alícuota. */
export const CTES_MINIMUM_BY_RATE: Readonly<Record<string, string>> = { "1.15": "80", "1.75": "125", "2.9": "200", "4.7": "330", "7": "490", "11.5": "800" };

export interface CtesRow {
    code: string;
    description: string;
    rate: string;
    minimum: string;
    regime: string;
    regimeName: string;
}

/** Filas del Anexo I. Una línea que empieza con código y no se puede leer completa es un problema (no se descarta en silencio). */
export function readCtesRows(text: string): { rows: CtesRow[]; problems: string[]; notTaxed: string[] } {
    const rows: CtesRow[] = [];
    const problems: string[] = [];
    const notTaxed: string[] = [];
    text.split(/\r?\n/).forEach((line, i) => {
        if (!/^\s*\d{5,6}\s/.test(line)) return;
        // «No alcanzado»: fuera del impuesto según el Anexo I; no genera regla (se informa).
        const na = /^\s*(\d{5,6})\s.*No alcanzado\s*$/i.exec(line);
        if (na) {
            notTaxed.push(pad(na[1]));
            return;
        }
        const m = /^\s*(\d{5,6})\s+(.*?)\s{2,}(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(\d{1,4})\s+(.+?)\s*$/.exec(line);
        if (!m) {
            problems.push(`línea ${i + 1} ilegible: ${line.trim().slice(0, 80)}`);
            return;
        }
        rows.push({ code: pad(m[1]), description: m[2].trim(), rate: normRate(m[3]), minimum: String(Number(m[4].replace(",", "."))), regime: m[5].padStart(4, "0"), regimeName: m[6].trim() });
    });
    return { rows, problems, notTaxed };
}

const CTES_COMMON: RuleCondition = {
    kind: "DECLARED_FACT",
    factKey: "ctesSinTratamientoEspecial",
    expected: true,
    description: "Sin exención ni tratamiento especial de la Ley Tarifaria o el Código Fiscal para el contribuyente (p. ej. industria radicada, art. 5)",
};
/** Regímenes alternativos al general: hecho declarado que los habilita. */
export const CTES_REGIME_FACTS: Readonly<Record<string, { factKey: string; yes: string; no: string }>> = {
    "0003": {
        factKey: "ctesVentaConsumidorFinal",
        yes: "Ventas a consumidores finales o al Estado (Ley Tarifaria art. 7: régimen «Por Menor»)",
        no: "Las ventas NO son a consumidores finales ni al Estado (Ley Tarifaria art. 7)",
    },
    "0004": { factKey: "ctesVentaMayorista", yes: "Venta al por mayor (régimen «Por Mayor» de la RG 293/2025)", no: "La venta NO es al por mayor" },
    "0005": { factKey: "ctesComision", yes: "Actividad por comisión o intermediación (régimen «Comisión» de la RG 293/2025)", no: "La actividad NO es por comisión" },
};
const CTES_HELD = "Mínimo por habitación, cama o sala según la categoría (Ley Tarifaria art. 10 B a D): cargar a mano.";
const CTES_MIN_MISMATCH = "El mínimo del Anexo I no coincide con el art. 10 A de la Ley Tarifaria para esa alícuota (p. ej. mínimo por habitación del art. 10 B): cargar a mano.";
const CTES_DUPLICATED = "El Anexo I trae más de una fila para el mismo régimen de este código (alícuotas distintas): fuente contradictoria, cargar a mano.";

export function buildCtesRules(rows: readonly CtesRow[], catalog: ReadonlySet<string>): { rules: RateRule[]; problems: string[]; notInCatalog: string[]; held: string[] } {
    const problems: string[] = [];
    const notInCatalog = new Set<string>();
    const held = new Set<string>();
    const byCode = new Map<string, CtesRow[]>();
    for (const r of rows) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
    const groups = new Map<string, RateRule>();
    const add = (key: string, code: string, make: () => Omit<RateRule, "activityCodes">) => {
        const g = groups.get(key);
        if (g) g.activityCodes.push(code);
        else groups.set(key, { ...make(), activityCodes: [code] });
    };
    for (const [code, list] of byCode) {
        if (!catalog.has(code)) {
            notInCatalog.add(code);
            continue;
        }
        const regimes = list.map((r) => r.regime);
        // Fuente contradictoria (p. ej. dos alícuotas en el régimen general): se retiene el código completo.
        const duplicated = new Set(regimes).size !== regimes.length;
        for (const r of list) {
            const expectedMin = CTES_MINIMUM_BY_RATE[r.rate];
            const minMismatch = (r.regime === "0001" || CTES_REGIME_FACTS[r.regime] !== undefined) && r.minimum !== "0" && expectedMin !== undefined && expectedMin !== r.minimum;
            const minimum: Pick<RateRule, "minimumMonthly"> = r.minimum !== "0" ? { minimumMonthly: r.minimum } : {};
            const base = { registrations: ["LOCAL", "CONVENIO_MULTILATERAL"] as RateRule["registrations"], validFrom: null, validTo: null, treatment: "RATE" as const, rate: r.rate };
            const ref = `RG DGR 293/2025, Anexo I (régimen ${r.regime} «${r.regimeName}»); mínimo: Ley Tarifaria 6249, art. 10`;
            const tag = `${r.rate.replace(".", "_")}-m${r.minimum.replace(".", "_")}`;
            if (duplicated) {
                held.add(code);
                add(`dup|${code}|${r.regime}|${r.rate}|${r.minimum}`, code, () => ({ ...base, id: `revisar-${code}-${r.regime}-${tag}`, conditions: [CTES_COMMON], legalReference: ref, ...minimum, pendingInterpretation: CTES_DUPLICATED }));
                continue;
            }
            if (r.regime === "0001") {
                const others = list.filter((x) => x.regime !== "0001").map((x) => x.regime);
                const unknown = others.filter((x) => !CTES_REGIME_FACTS[x]);
                const conds: RuleCondition[] = [CTES_COMMON, ...others.filter((x) => CTES_REGIME_FACTS[x]).map((x) => ({ kind: "DECLARED_FACT" as const, factKey: CTES_REGIME_FACTS[x].factKey, expected: false, description: CTES_REGIME_FACTS[x].no }))];
                const holdText = unknown.length > 0 ? CTES_HELD : minMismatch ? CTES_MIN_MISMATCH : null;
                if (holdText) held.add(code);
                add(`g|${tag}|${others.join(",")}|${holdText ?? ""}`, code, () => ({
                    ...base,
                    id: `general-${tag}${others.length ? `-excepto-${others.join("-")}` : ""}${holdText ? "-retenida" : ""}`,
                    conditions: conds,
                    legalReference: ref,
                    ...minimum,
                    ...(holdText ? { pendingInterpretation: holdText } : {}),
                }));
            } else if (CTES_REGIME_FACTS[r.regime]) {
                const f = CTES_REGIME_FACTS[r.regime];
                if (minMismatch) held.add(code);
                add(`a|${r.regime}|${tag}|${minMismatch}`, code, () => ({
                    ...base,
                    id: `${f.factKey}-${tag}${minMismatch ? "-retenida" : ""}`,
                    conditions: [CTES_COMMON, { kind: "DECLARED_FACT", factKey: f.factKey, expected: true, description: f.yes }],
                    legalReference: ref,
                    ...minimum,
                    ...(minMismatch ? { pendingInterpretation: CTES_MIN_MISMATCH } : {}),
                }));
            } else {
                held.add(code);
                add(`h|${r.regime}|${tag}`, code, () => ({ ...base, id: `categoria-${r.regime}-${tag}`, conditions: [CTES_COMMON], legalReference: ref, pendingInterpretation: CTES_HELD }));
            }
        }
    }
    return { rules: [...groups.values()], problems, notInCatalog: [...notInCatalog].sort(), held: [...held].sort() };
}

/* ------------------------------ Santa Cruz ------------------------------ */

export const SC_ID = "santa-cruz-ley-3485-2026";
const SC_URL = "https://www.asip.gob.ar/wp-content/uploads/2026/10/asip-archivo-4012.pdf";
/** Ley 3485, art. 7: actividades con mínimo mensual. */
export const SC_MINIMUMS: Readonly<Record<string, string>> = { "551010": "3500", "939030": "6000" };

/**
 * Filas del Anexo I: la alícuota puede estar en la línea del código o, si la
 * descripción ocupa varias líneas, en una línea vecina sin código. Cada línea
 * de alícuota sin código se asigna al código más cercano (±2 líneas) que no la
 * tenga; si hay empate o queda alguna sin asignar, es un problema.
 */
export function readScRows(text: string): { rows: { code: string; rate: string }[]; problems: string[] } {
    const lines = text.split(/\r?\n/);
    const codeAt = new Map<number, string>();
    const rateAt = new Map<number, string>();
    lines.forEach((l, i) => {
        const c = /^\s*(\d{5,6})\b/.exec(l);
        const r = /(\d{1,2}(?:,\d{1,2})?)\s*%\s*$/.exec(l);
        if (c) codeAt.set(i, pad(c[1]));
        if (r) rateAt.set(i, normRate(r[1]));
    });
    const rate = new Map<number, string>();
    const problems: string[] = [];
    for (const [i] of codeAt) if (rateAt.has(i)) rate.set(i, rateAt.get(i)!);
    for (const [i, r] of rateAt) {
        if (codeAt.has(i)) continue;
        const near = [-1, 1, -2, 2].map((d) => i + d).filter((j) => codeAt.has(j) && !rate.has(j) && !rateAt.has(j));
        const best = near.filter((j) => Math.abs(j - i) === Math.abs(near[0] - i));
        if (near.length === 0) problems.push(`línea ${i + 1}: alícuota ${r} sin código cercano`);
        else if (best.length > 1) problems.push(`línea ${i + 1}: alícuota ${r} ambigua entre ${best.map((j) => codeAt.get(j)).join(" y ")}`);
        else rate.set(best[0], r);
    }
    const rows: { code: string; rate: string }[] = [];
    for (const [i, code] of codeAt) {
        if (rate.has(i)) rows.push({ code, rate: rate.get(i)! });
        else problems.push(`código ${code} (línea ${i + 1}): sin alícuota`);
    }
    return { rows, problems };
}

const SC_COMMON: RuleCondition = {
    kind: "DECLARED_FACT",
    factKey: "scRegimenGeneral",
    expected: true,
    description: "Contribuyente del régimen general (no del Régimen Simplificado, art. 9) y sin exención ni tratamiento especial",
};

export function buildScRules(rows: readonly { code: string; rate: string }[], catalog: ReadonlySet<string>) {
    const problems: string[] = [];
    const notInCatalog: string[] = [];
    const seen = new Map<string, string>();
    for (const r of rows) {
        const prev = seen.get(r.code);
        if (prev !== undefined && prev !== r.rate) problems.push(`código ${r.code}: dos alícuotas (${prev} y ${r.rate})`);
        seen.set(r.code, r.rate);
    }
    const groups = new Map<string, RateRule>();
    for (const [code, rate] of seen) {
        if (!catalog.has(code)) {
            notInCatalog.push(code);
            continue;
        }
        const min = SC_MINIMUMS[code];
        const key = `${rate}|${min ?? ""}`;
        const g = groups.get(key);
        if (g) g.activityCodes.push(code);
        else
            groups.set(key, {
                id: `anexo-i-${rate.replace(".", "_")}${min ? `-minimo-${min}` : ""}`,
                activityCodes: [code],
                registrations: ["LOCAL", "CONVENIO_MULTILATERAL"],
                validFrom: null,
                validTo: null,
                treatment: "RATE",
                rate,
                conditions: [SC_COMMON],
                legalReference: `Ley 3485 (Ley Impositiva), art. 5 y Anexo I (texto de referencia ASIP, posterior a la Ley 3760)${min ? "; mínimo: art. 7" : ""}`,
                ...(min ? { minimumMonthly: min } : {}),
            });
    }
    for (const c of Object.keys(SC_MINIMUMS)) if (!seen.has(c)) problems.push(`código ${c} con mínimo (art. 7) sin alícuota en el Anexo I`);
    return { rules: [...groups.values()], problems, notInCatalog: notInCatalog.sort() };
}

/* --------------------------------- CLI ---------------------------------- */

function write(a: Record<string, string>, set: RateRuleSet, summary: string, problems: string[]): number {
    const all = [...problems, ...validateRuleSet(set)];
    console.log(summary);
    if (all.length > 0) {
        console.error(`CONJUNTO RECHAZADO:\n- ${all.slice(0, 30).join("\n- ")}`);
        return 2;
    }
    writeFileSync(required(a, "out"), `${JSON.stringify(set, null, 1)}\n`, { flag: "wx" });
    console.log(`escrito ${required(a, "out")} en estado PENDIENTE_REVISION.`);
    return 0;
}

function catalogCodes(path: string, expected = "naes-rg-ca-19-2025"): { id: string; codes: Set<string> } {
    const catalog = JSON.parse(readFileSync(path, "utf8")) as CatalogFile;
    if (catalog.manifest.id !== expected) throw new Error(`se espera el catálogo ${expected}`);
    return { id: catalog.manifest.id, codes: new Set(catalog.entries.filter((e) => !e.validTo || e.validTo >= "2026-01-01").map((e) => e.code)) };
}

export function ctes2026Main(argv: string[]): number {
    const a = parseArgs(argv);
    const cat = catalogCodes(required(a, "catalog"));
    const { rows, problems: readProblems, notTaxed } = readCtesRows(readFileSync(required(a, "text"), "utf8"));
    const { rules, problems: ruleProblems, notInCatalog, held } = buildCtesRules(rows, cat.codes);
    const problems = [...readProblems, ...ruleProblems];
    const set: RateRuleSet = {
        manifest: {
            id: CTES_ID,
            jurisdiction: "905",
            nomenclator: "NAES",
            catalogIds: [cat.id],
            organism: "Dirección General de Rentas de Corrientes",
            norm: "RG DGR 293/2025, Anexo I; Ley Tarifaria 6249 (art. 10, mínimos)",
            sourceUrl: CTES_URL,
            publishedAt: "2025-12-30",
            consultedAt: required(a, "consulted"),
            version: "Nomenclador NAES con alícuotas, mínimos y regímenes vigente desde el 01/01/2026",
            validFrom: "2026-01-01",
            validTo: "2026-12-31",
            sourceSha256: sha256Hex(readFileSync(required(a, "pdf"))),
            review: pendingReview(RULES_REVIEW_LEVELS),
        },
        rules,
    };
    const codes = new Set(rules.flatMap((r) => r.activityCodes));
    return write(a, set, `${rows.length} filas; ${codes.size} códigos con regla; ${notInCatalog.length} fuera del catálogo NAES (${notInCatalog.join(", ")}); ${held.length} retenidos (${held.join(", ")}); no alcanzados sin regla: ${notTaxed.join(", ")}`, problems);
}

export function sc2026Main(argv: string[]): number {
    const a = parseArgs(argv);
    // La Ley 3485 usa los códigos de AFIP (F-883): catálogo de ARCA (decisión del estudio, 24/11/2026).
    const cat = catalogCodes(required(a, "catalog"), "clae-rg-afip-3537-2013");
    const parsed = readScRows(readFileSync(required(a, "text"), "utf8"));
    const { rules, problems, notInCatalog } = buildScRules(parsed.rows, cat.codes);
    const set: RateRuleSet = {
        manifest: {
            id: SC_ID,
            jurisdiction: "920",
            nomenclator: "ARCA",
            catalogIds: [cat.id],
            organism: "Agencia Santacruceña de Ingresos Públicos (ASIP)",
            norm: "Ley 3485 (Ley Impositiva) y modificatorias (Leyes 3596, 3759 y 3760): art. 5, art. 7 y Anexo I",
            sourceUrl: SC_URL,
            publishedAt: "2021-11-25",
            consultedAt: required(a, "consulted"),
            version: "Anexo I según el texto de referencia publicado por ASIP (posterior a la Ley 3760, B.O. 25/11/2021; ASIP aclara que la fecha de actualización no está acreditada)",
            validFrom: "2026-01-01",
            validTo: "2026-12-31",
            sourceSha256: sha256Hex(readFileSync(required(a, "pdf"))),
            review: pendingReview(RULES_REVIEW_LEVELS),
        },
        rules,
    };
    const codes = new Set(rules.flatMap((r) => r.activityCodes));
    return write(a, set, `${parsed.rows.length} filas; ${codes.size} códigos con regla; ${notInCatalog.length} fuera del catálogo de ARCA, sin regla (${notInCatalog.join(", ")})`, [...parsed.problems, ...problems]);
}

/* ------------------------- Tierra del Fuego 2026 ------------------------ */

const TDF_ID = "tierra-del-fuego-ley-1498-2026";
const TDF_URL = "https://www1.tcptdf.gob.ar/tcp-publico/leyes-provinciales/LEY%20PROVINCIAL%20N%C2%BA%201498.pdf";

/**
 * Anexo I de la Ley provincial 1498 (sustituye el Anexo I - Nomenclador de
 * Actividades de la Ley 440). El PDF oficial es una copia ESCANEADA: su texto
 * no se puede extraer con fiabilidad, por eso sólo se transcriben a mano los
 * códigos que usa el estudio, leídos sobre la imagen (página 166 del PDF,
 * hoja 134 del anexo). Columnas: Alícuota IIBB · Alícuota FFSS · Alícuota FOFISP.
 * Decisión del estudio (26/11/2026): sólo estos códigos; vigente 2026 con la
 * salvedad de no haber hallado modificaciones posteriores en AREF.
 */
export const TDF_2026_ROWS: ReadonlyArray<{ code: string; description: string; rate: string; ffss: string; page: number }> = [
    { code: "791101", description: "Servicios minoristas de agencias de viajes excepto en comisión", rate: "0.5", ffss: "1.5", page: 166 },
    { code: "791102", description: "Servicios minoristas de agencias de viajes en comisión", rate: "0.5", ffss: "1.5", page: 166 },
    { code: "791201", description: "Servicios mayoristas de agencias de viajes excepto en comisión", rate: "0.5", ffss: "1.5", page: 166 },
    { code: "791202", description: "Servicios mayoristas de agencias de viajes en comisión", rate: "0.5", ffss: "1.5", page: 166 },
];

export function buildTdfRules(rows: typeof TDF_2026_ROWS, catalog: Set<string>): { rules: RateRule[]; problems: string[] } {
    const problems = rows.filter((r) => !catalog.has(r.code)).map((r) => `${r.code}: no está en el catálogo NAES`);
    const groups = new Map<string, RateRule>();
    for (const r of rows) {
        const id = `anexo-i-${r.rate.replace(".", "_")}-ffss-${r.ffss.replace(".", "_")}`;
        const g = groups.get(id) ?? {
            id,
            activityCodes: [],
            registrations: ["LOCAL", "CONVENIO_MULTILATERAL"],
            validFrom: null,
            validTo: null,
            treatment: "RATE",
            rate: r.rate,
            conditions: [],
            legalReference: `Ley 1498, Anexo I (Nomenclador de Actividades de la Ley 440), pág. ${r.page} del PDF oficial`,
            caveat: "No aplica a contribuyentes del Régimen Simplificado de IIBB de Tierra del Fuego (tributan importes fijos; tampoco el FFSS). Verificá que el cliente esté en el régimen general.",
            additional: { label: "FFSS", rate: r.ffss },
        } as RateRule;
        g.activityCodes.push(r.code);
        groups.set(id, g);
    }
    return { rules: [...groups.values()], problems };
}

export function tdf2026Main(argv: string[]): number {
    const a = parseArgs(argv);
    const cat = catalogCodes(required(a, "catalog"));
    const { rules, problems } = buildTdfRules(TDF_2026_ROWS, cat.codes);
    const set: RateRuleSet = {
        manifest: {
            id: TDF_ID,
            jurisdiction: "923",
            nomenclator: "NAES",
            catalogIds: [cat.id],
            organism: "Agencia de Recaudación Fueguina (AREF)",
            norm: "Ley 440 (Ley Impositiva) y modificatorias; Anexo I según Ley 1498 (B.O. 2023); alícuota adicional FFSS (Ley 907, art. 7, texto Ley 1340)",
            sourceUrl: TDF_URL,
            publishedAt: "2023-09-30",
            consultedAt: required(a, "consulted"),
            version: "Anexo I de la Ley 1498 (vigente desde el 01/01/2024); sin modificaciones posteriores halladas en la normativa «Impositiva» de AREF al 26/11/2026. Transcripción manual de los códigos que usa el estudio.",
            validFrom: "2026-01-01",
            validTo: "2026-12-31",
            sourceSha256: sha256Hex(readFileSync(required(a, "pdf"))),
            review: pendingReview(RULES_REVIEW_LEVELS),
        },
        rules,
    };
    return write(a, set, `${TDF_2026_ROWS.length} códigos transcriptos; ${rules.length} regla(s)`, problems);
}
