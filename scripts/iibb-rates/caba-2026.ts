/**
 * Conjunto de reglas de alícuotas de CABA (901) para 2026, generado de forma
 * REPRODUCIBLE a partir de las fuentes oficiales:
 *
 *  - Ley 6927 (Ley Impositiva 2026, BOCBA 7269 del 19/12/2025), Anexo con la
 *    aclaración/fe de erratas publicada en BOCBA 7275 (02/01/2026). De ahí salen
 *    las «Planillas adjuntas de actividades 1 a 11 – Codificación NAES».
 *  - Ley 6948 (BOCBA 7369 del 19/05/2026): sustituye los arts. 3°, 5°, 6°, 8°,
 *    9°, 10 y 11 del Anexo (nuevos umbrales) desde el primer día hábil del mes
 *    siguiente a su publicación (lunes 01/06/2026).
 *  - Ley 6942 sólo agrega una cláusula transitoria sobre Patentes: no afecta IIBB.
 *
 * Qué se transcribe a mano (y se coteja): las tasas y umbrales de los
 * artículos 1° a 11 (`ARTICLES`), copiados del texto de la ley. El script
 * verifica que cada fila de cada planilla del PDF tenga exactamente las tasas
 * del artículo correspondiente; si no, falla.
 *
 * Qué queda AFUERA a propósito (sin regla = «Alícuota pendiente de determinar»):
 *  - Los códigos citados expresamente en los arts. 12 a 21 y 26 (tratamientos
 *    especiales que, según el art. 22, prevalecen sobre las planillas).
 *  - Los códigos NAES que no figuran en ninguna planilla.
 *  - Exenciones y otros tratamientos del Código Fiscal: cada regla exige que el
 *    estudio confirme que no hay otro tratamiento previsto (condición declarada).
 *
 *   swiftc -O -o /tmp/pdflines scripts/activity-catalogs/pdflines.swift
 *   /tmp/pdflines <anexo-fe-de-erratas.pdf> > anexo.lines
 *   /tmp/pdftext  <anexo-fe-de-erratas.pdf> > anexo.txt
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- caba-2026 \
 *     --annex-pdf <anexo-fe-de-erratas.pdf> --lines anexo.lines --text anexo.txt \
 *     --catalog data/activity-catalogs/naes-rg-ca-19-2025.json --consulted AAAA-MM-DD \
 *     --out data/iibb-rate-rules/caba-ley-6927-2026.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sha256Hex } from "../../lib/activity-catalog/checksum";
import type { CatalogFile } from "../../lib/activity-catalog/types";
import type { RateRule, RateRuleSet, RuleCondition } from "../../lib/iibb-rates/types";
import { validateRuleSet } from "../../lib/iibb-rates/validate";
import { RULES_REVIEW_LEVELS, pendingReview } from "../../lib/activity-catalog/review";
import { parseArgs, required } from "../activity-catalogs/import";
import { parsePdfLines, type PdfLine } from "../activity-catalogs/pdf-table";

export const SET_ID = "caba-ley-6927-2026";
const ANNEX_URL = "https://documentosboletinoficial.buenosaires.gob.ar/publico/PL-FEERR-LCABA-LCABA-6927-25-ANX.pdf";
const LAW_6948_URL = "https://documentosboletinoficial.buenosaires.gob.ar/publico/ck_PL-LEY-LCABA-LCBA-6948-26-7369.pdf";
/** Ley 6948, art. 10: primer día hábil del mes siguiente a su publicación (19/05/2026). */
const FROM_6948 = "2026-06-01";
const UNTIL_6948 = "2026-05-31";

interface Tier {
    /** Umbral de ingresos brutos anuales del ejercicio anterior, en pesos. */
    threshold: string;
    low: string;
    high: string;
}

interface ArticleSpec {
    article: number;
    /** Tasa única (arts. 1°, 2°, 4° y 7°). */
    rate?: string;
    /** Arts. con umbral: texto original de la Ley 6927 y sustitución por la Ley 6948. */
    tiers?: { ley6927: Tier; ley6948: Tier };
    /** Condiciones declaradas adicionales del artículo. */
    extra?: RuleCondition[];
}

/** Hecho común a los arts. 1° a 11: «en tanto no tengan previsto otro tratamiento en esta Ley o en el Código Fiscal». */
const NO_OTHER_TREATMENT: RuleCondition = {
    kind: "DECLARED_FACT",
    factKey: "cabaSinOtroTratamiento",
    expected: true,
    description: "La actividad no tiene previsto otro tratamiento en la Ley Impositiva 2026 ni en el Código Fiscal (exenciones, otras alícuotas o facetas con gravamen distinto)",
};

const RESIDENTIAL = (expected: boolean): RuleCondition => ({
    kind: "DECLARED_FACT",
    factKey: "cabaConsumidorResidencial",
    expected,
    description: expected
        ? "Ingresos de servicios de electricidad, gas y agua con destinatario consumidor residencial (excepto inc. 20 del art. 19 y art. 58)"
        : "Ingresos que NO provienen de servicios de electricidad, gas y agua a consumidores residenciales",
});

/** Transcripción de los arts. 1° a 11 del Anexo (Ley 6927 con fe de erratas; arts. sustituidos por la Ley 6948). */
export const ARTICLES: readonly ArticleSpec[] = [
    { article: 1, rate: "0" },
    {
        article: 2,
        rate: "1",
        extra: [
            {
                kind: "DECLARED_FACT",
                factKey: "cabaVentaNoEstadoNiConsumidorFinal",
                expected: true,
                description:
                    "Ingresos que no provienen de ventas a los Estados (Nacional, Provincial, CABA, municipios, sus entes y empresas) ni a consumidores finales (salvo software, Ley 6.394)",
            },
            {
                kind: "DECLARED_FACT",
                factKey: "cabaActividadIndustrial",
                expected: true,
                description: "Actividad industrial según el art. 2° (transformación en establecimiento industrial), no hidrocarburífera ni comprendida en el art. 22 de la Ley 23.966",
            },
            {
                kind: "DECLARED_FACT",
                factKey: "cabaNoBienesDeUso",
                expected: true,
                description: "Ingresos que no provienen de ventas de bienes muebles destinados a ser afectados por los compradores como «bienes de uso» (tributan bajo el régimen general, art. 2°)",
            },
        ],
    },
    { article: 3, tiers: { ley6927: { threshold: "2004000000", low: "3", high: "3.75" }, ley6948: { threshold: "2154300000", low: "3", high: "3.75" } }, extra: [RESIDENTIAL(false)] },
    { article: 4, rate: "2" },
    { article: 5, tiers: { ley6927: { threshold: "364000000", low: "3", high: "5" }, ley6948: { threshold: "391128000", low: "3", high: "5" } } },
    { article: 6, tiers: { ley6927: { threshold: "2004000000", low: "3", high: "4.5" }, ley6948: { threshold: "2154300000", low: "3", high: "4.5" } } },
    { article: 7, rate: "2" },
    { article: 8, tiers: { ley6927: { threshold: "2004000000", low: "3", high: "4" }, ley6948: { threshold: "2154300000", low: "3", high: "4" } } },
    { article: 9, tiers: { ley6927: { threshold: "2004000000", low: "3", high: "5" }, ley6948: { threshold: "2154300000", low: "3", high: "5" } } },
    { article: 10, tiers: { ley6927: { threshold: "2004000000", low: "3", high: "4.75" }, ley6948: { threshold: "2154300000", low: "3", high: "4.75" } } },
    { article: 11, tiers: { ley6927: { threshold: "2004000000", low: "3", high: "5" }, ley6948: { threshold: "2154300000", low: "3", high: "5" } } },
];

/** Art. 3°, último párrafo: 4,00% a consumidores residenciales (sin cambios en la Ley 6948). */
const RESIDENTIAL_RATE = "4";

/**
 * Interpretaciones que el estudio todavía no decidió: las reglas que dependen
 * de ellas se generan RETENIDAS (nunca se sugieren ni se aceptan al guardar).
 */
export const HOLD_LEY_6948 =
    "Ley 6948: confirmar (a) el inicio de vigencia del art. 10 («primer día hábil del mes siguiente al de su publicación», BOCBA 19/05/2026; se propone el lunes 01/06/2026) y (b) el alcance del art. 9° («adecuación de las planillas»: se propone mantener los códigos de las planillas de la Ley 6927 y cambiar sólo umbrales).";
export const HOLD_RESIDENTIAL =
    "Art. 3°, último párrafo: confirmar el alcance de las excepciones «inciso 20 del artículo 19» y «artículo 58» antes de sugerir el 4 % a consumidores residenciales.";

export interface PlanillaRow {
    planilla: number;
    code: string;
    /** Tasas de la fila tal como figuran en el PDF ("3,00%"), de izquierda a derecha. */
    rates: string[];
}

/** «3,75%» -> "3.75"; «0,00%» -> "0". */
export function percentToRate(s: string): string {
    const m = /^(\d+),(\d{2})%$/.exec(s.trim());
    if (!m) throw new Error(`tasa no reconocida en la planilla: "${s}"`);
    const frac = m[2].replace(/0+$/, "");
    return frac ? `${Number(m[1])}.${frac}` : String(Number(m[1]));
}

/** Filas de las planillas (código en la columna izquierda; tasas «N,NN%» a la derecha de la misma fila). */
export function readPlanillas(lines: readonly PdfLine[]): PlanillaRow[] {
    const start = lines.findIndex((l) => /^APARTADO I – ARTÍCULO 1°/.test(l.text));
    if (start < 0) throw new Error("no se encontró el comienzo de las planillas (APARTADO I – ARTÍCULO 1°)");
    const rows: PlanillaRow[] = [];
    let planilla: number | null = null;
    for (let i = start; i < lines.length; i++) {
        const l = lines[i];
        const head = /^APARTADO [IVX]+ – ARTÍCULO (\d+)/.exec(l.text);
        if (head) {
            planilla = Number(head[1]);
            continue;
        }
        if (planilla === null || l.x >= 140 || !/^\d{6}$/.test(l.text)) continue;
        const cells = lines
            .filter((k) => k.page === l.page && k.x > 380 && k.y <= l.y + 1.5 && l.y - k.y < 12 && /^\d+,\d{2}%$/.test(k.text))
            .sort((a, b) => a.x - b.x);
        if (cells.length === 0) throw new Error(`planilla ${planilla}, código ${l.text}: sin tasa en la fila`);
        rows.push({ planilla, code: l.text, rates: cells.map((c) => c.text) });
    }
    return rows;
}

/** Códigos NAES (6 dígitos) citados en los arts. 12 a 21 y 26 del Anexo: tratamientos especiales. */
export function specialArticleCodes(annexText: string): Set<string> {
    const from = annexText.indexOf("Artículo 12.-");
    const to = annexText.indexOf("Artículo 22.-");
    const a26 = annexText.indexOf("Artículo 26.");
    const a27 = annexText.indexOf("Artículo 27.-");
    if (from < 0 || to < 0 || a26 < 0 || a27 < 0) throw new Error("no se encontraron los arts. 12, 22, 26 y 27 en el texto del Anexo");
    const text = annexText.slice(from, to) + annexText.slice(a26, a27);
    return new Set(text.match(/\b\d{6}\b/g) ?? []);
}

/** "2154300000" -> "2.154.300.000" (sin depender de la configuración regional de Node). */
const pesos = (amount: string) => amount.replace(/\B(?=(\d{3})+$)/g, ".");

const income = (minExclusive: string | null, maxInclusive: string | null, law: string): RuleCondition => ({
    kind: "PRIOR_YEAR_GROSS_INCOME",
    minExclusive,
    maxInclusive,
    description:
        maxInclusive !== null
            ? `Ingresos brutos anuales del ejercicio fiscal anterior iguales o inferiores a $${pesos(maxInclusive)} (${law})`
            : `Ingresos brutos anuales del ejercicio fiscal anterior superiores a $${pesos(minExclusive!)} (${law})`,
});

export interface CabaExclusions {
    /** Códigos de planillas citados en los arts. 12 a 21 y 26 (tratamiento especial). */
    special: string[];
    /** Códigos que figuran en más de una planilla (encuadre ambiguo). */
    ambiguous: Array<{ code: string; planillas: number[] }>;
}

export function buildCabaRules(rows: readonly PlanillaRow[], special: ReadonlySet<string>, catalogCodes: ReadonlySet<string>): { rules: RateRule[]; excluded: string[]; exclusions: CabaExclusions } {
    const rules: RateRule[] = [];
    const excluded = new Set<string>();
    const planillasOf = new Map<string, number[]>();
    for (const r of rows) planillasOf.set(r.code, [...(planillasOf.get(r.code) ?? []), r.planilla]);
    const ambiguous = [...planillasOf].filter(([, p]) => p.length > 1).map(([code, planillas]) => ({ code, planillas })).sort((a, b) => a.code.localeCompare(b.code));
    const isAmbiguous = new Set(ambiguous.map((a) => a.code));
    for (const spec of ARTICLES) {
        const inPlanilla = rows.filter((r) => r.planilla === spec.article);
        if (inPlanilla.length === 0) throw new Error(`planilla ${spec.article} vacía`);
        const expected = spec.rate !== undefined ? [spec.rate] : [spec.tiers!.ley6927.low, spec.tiers!.ley6927.high];
        for (const r of inPlanilla) {
            const got = r.rates.map(percentToRate);
            if (JSON.stringify(got) !== JSON.stringify(expected)) {
                throw new Error(`planilla ${spec.article}, código ${r.code}: tasas del PDF ${r.rates.join("/")} distintas de las del artículo (${expected.join("/")})`);
            }
            if (!catalogCodes.has(r.code)) throw new Error(`planilla ${spec.article}: el código ${r.code} no está vigente en el catálogo NAES`);
        }
        // Sin tasa automática: tratamientos especiales y códigos en más de una planilla.
        const codes = [...new Set(inPlanilla.map((r) => r.code).filter((c) => (special.has(c) ? (excluded.add(c), false) : !isAmbiguous.has(c))))].sort();
        const conditions = [NO_OTHER_TREATMENT, ...(spec.extra ?? [])];
        const ref = `Ley 6927, Anexo, art. ${spec.article}${spec.article < 10 ? "°" : ""} y Planilla ${spec.article}`;
        const base = { activityCodes: codes, registrations: [], treatment: "RATE" as const };
        if (spec.rate !== undefined) {
            rules.push({ ...base, id: `a${spec.article}`, validFrom: null, validTo: null, rate: spec.rate, conditions, legalReference: ref });
        } else {
            const { ley6927: t1, ley6948: t2 } = spec.tiers!;
            const ref2 = `Ley 6948 (sustituye el art. ${spec.article}${spec.article < 10 ? "°" : ""} del Anexo de la Ley 6927) y Planilla ${spec.article}`;
            rules.push(
                { ...base, id: `a${spec.article}-ene-may-hasta`, validFrom: null, validTo: UNTIL_6948, rate: t1.low, conditions: [...conditions, income(null, t1.threshold, "Ley 6927")], legalReference: ref },
                { ...base, id: `a${spec.article}-ene-may-supera`, validFrom: null, validTo: UNTIL_6948, rate: t1.high, conditions: [...conditions, income(t1.threshold, null, "Ley 6927")], legalReference: ref },
                {
                    ...base,
                    id: `a${spec.article}-jun-dic-hasta`,
                    validFrom: FROM_6948,
                    validTo: null,
                    rate: t2.low,
                    conditions: [...conditions, income(null, t2.threshold, "Ley 6948")],
                    legalReference: ref2,
                    sourceUrl: LAW_6948_URL,
                    pendingInterpretation: HOLD_LEY_6948,
                },
                {
                    ...base,
                    id: `a${spec.article}-jun-dic-supera`,
                    validFrom: FROM_6948,
                    validTo: null,
                    rate: t2.high,
                    conditions: [...conditions, income(t2.threshold, null, "Ley 6948")],
                    legalReference: ref2,
                    sourceUrl: LAW_6948_URL,
                    pendingInterpretation: HOLD_LEY_6948,
                },
            );
        }
        if (spec.article === 3) {
            rules.push({
                ...base,
                id: "a3-residencial",
                validFrom: null,
                validTo: null,
                rate: RESIDENTIAL_RATE,
                conditions: [NO_OTHER_TREATMENT, RESIDENTIAL(true)],
                legalReference: "Ley 6927, Anexo, art. 3°, último párrafo (texto sin cambios en la Ley 6948) y Planilla 3",
                pendingInterpretation: HOLD_RESIDENTIAL,
            });
        }
    }
    return { rules, excluded: [...excluded].sort(), exclusions: { special: [...excluded].sort(), ambiguous } };
}

export function cabaMain(argv: string[]): number {
    const a = parseArgs(argv);
    const req = (k: string) => required(a, k);
    const catalog = JSON.parse(readFileSync(req("catalog"), "utf8")) as CatalogFile;
    if (catalog.manifest.id !== "naes-rg-ca-19-2025") throw new Error("se espera el catálogo naes-rg-ca-19-2025");
    const valid2026 = new Set(catalog.entries.filter((e) => !e.validTo || e.validTo >= "2026-01-01").map((e) => e.code));
    const rows = readPlanillas(parsePdfLines(readFileSync(req("lines"), "utf8")));
    const special = specialArticleCodes(readFileSync(req("text"), "utf8"));
    const { rules, excluded, exclusions } = buildCabaRules(rows, special, valid2026);
    const set: RateRuleSet = {
        manifest: {
            id: SET_ID,
            jurisdiction: "901",
            nomenclator: "NAES",
            catalogIds: [catalog.manifest.id],
            organism: "Legislatura de la Ciudad Autónoma de Buenos Aires",
            norm: "Ley 6927 (Ley Impositiva 2026) y Ley 6948",
            sourceUrl: ANNEX_URL,
            publishedAt: "2025-12-19",
            consultedAt: req("consulted"),
            version: "Ley Impositiva 2026: Ley 6927 con fe de erratas (BOCBA 7275) y Ley 6948",
            validFrom: "2026-01-01",
            validTo: "2026-12-31",
            sourceSha256: sha256Hex(readFileSync(req("annex-pdf"))),
            review: pendingReview(RULES_REVIEW_LEVELS),
        },
        rules,
    };
    const problems = validateRuleSet(set);
    const codes = new Set(rules.flatMap((r) => r.activityCodes));
    const held = rules.filter((r) => r.pendingInterpretation !== undefined).length;
    console.log(
        `${rows.length} filas de planillas; ${codes.size} códigos con regla; ${excluded.length} excluidos por tratamiento especial (arts. 12 a 21 y 26); ${exclusions.ambiguous.length} excluidos por figurar en más de una planilla; ${held} reglas retenidas`,
    );
    if (a.report) {
        const report = { generatedFor: SET_ID, planillaRows: rows.length, codesWithRule: codes.size, heldRules: rules.filter((r) => r.pendingInterpretation).map((r) => ({ id: r.id, hold: r.pendingInterpretation })), exclusions, specialCodesCitedInArticles12to21and26: [...special].sort() };
        writeFileSync(a.report, `${JSON.stringify(report, null, 1)}\n`, { flag: "wx" });
    }
    if (problems.length > 0) {
        console.error(`CONJUNTO RECHAZADO:\n- ${problems.join("\n- ")}`);
        return 2;
    }
    writeFileSync(req("out"), `${JSON.stringify(set, null, 1)}\n`, { flag: "wx" });
    console.log(`escrito ${req("out")} en estado PENDIENTE_REVISION.`);
    return 0;
}
