/**
 * Reglas de alícuotas de la Provincia de Buenos Aires (902) para 2026, desde la
 * exportación OFICIAL alicuotaria de ARBA (período 202601–202612), CONTRASTADA
 * fila por fila con el art. 20 de la Ley 15.558 (Impositiva 2026, BO
 * 15/12/2025): para cada código se evalúan las 8 columnas de la ley (general y
 * tramos 1 a 7) contra los tramos de la exportación. Cualquier diferencia hace
 * fallar la generación.
 *
 *   swiftc -O -o /tmp/pdflines scripts/activity-catalogs/pdflines.swift
 *   /tmp/pdflines leyimpositiva2026.pdf > ley.lines
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- arba-2026 \
 *     --alicuotaria NAIIBB18_ALICUOTARIA.xls --law-pdf leyimpositiva2026.pdf --law-lines ley.lines \
 *     --catalog data/activity-catalogs/arba-naiibb18-<fecha>.json --consulted AAAA-MM-DD \
 *     --out data/iibb-rate-rules/arba-ley-15558-2026.json
 *
 * Qué NO se convierte en regla habilitada:
 *  - filas «Art.22» / «Art.134» (tratamientos especiales condicionados): retenidas;
 *  - códigos con `bonif_actiba = S` o `AlicuotaSUS` (sin definición normativa
 *    verificada): retenidos;
 *  - la alícuota «G» (general) como tasa automática: los tramos de la
 *    exportación ya cubren todo el rango de ingresos;
 *  - montos mínimos, régimen simplificado (importes fijos) y otros años.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sha256Hex } from "../../lib/activity-catalog/checksum";
import { RULES_REVIEW_LEVELS, pendingReview } from "../../lib/activity-catalog/review";
import type { CatalogFile } from "../../lib/activity-catalog/types";
import type { RateRule, RateRuleSet, RuleCondition } from "../../lib/iibb-rates/types";
import { validateRuleSet } from "../../lib/iibb-rates/validate";
import { compareMoney } from "../../lib/iibb-rates/suggest";
import { ALICUOTARIA_HEADER, arbaRates, readTsvLatin1, type ArbaRateRow } from "../activity-catalogs/arba-naiibb";
import { parseArgs, required } from "../activity-catalogs/import";
import { parsePdfLines, type PdfLine } from "../activity-catalogs/pdf-table";

export const SET_ID = "arba-ley-15558-2026";
const LAW_URL = "https://www.arba.gov.ar/archivos/Publicaciones/leyimpositiva2026.pdf";

/** Topes de los tramos 1 a 7 (art. 20, incs. a a g, Ley 15.558). */
export const TRAMO_CAPS = ["1834326000", "1222884000", "917163000", "163364760", "47034000", "31356000", "15286053"] as const;

/** Columnas de la tabla del art. 20: general y tramos 1 a 7. */
const LAW_COLUMNS = 8;

const n = (s: string) => {
    const [i, f = ""] = s.split(".");
    const frac = f.replace(/0+$/, "");
    return `${i.replace(/^0+(?=\d)/, "")}${frac ? `.${frac}` : ""}`;
};

/** Fila de la tabla de la ley: código de clase (4 dígitos) o de tratamiento especial (6), y 8 tasas. */
export function readLawTable(lines: readonly PdfLine[]): Map<string, string[]> {
    const start = lines.findIndex((l) => l.text.startsWith("ARTÍCULO 20."));
    const end = lines.findIndex((l, i) => i > start && l.text.startsWith("ARTÍCULO 21"));
    if (start < 0 || end < 0) throw new Error("no se encontraron los arts. 20 y 21 de la ley");
    const body = lines.slice(start, end);
    const table = new Map<string, string[]>();
    for (const l of body) {
        // El código puede venir solo o en la misma selección que la descripción («502102 Servicio de…»).
        const m = /^(\d{4}|\d{6})(?:\s|$)/.exec(l.text);
        if (l.x >= 135 || !m) continue;
        const code = m[1];
        // Tasas de la fila, en orden horizontal; la general puede venir pegada al final del texto del código.
        const embedded = l.text.match(/\d+(?:,\d+)?%$/)?.[0];
        const cells = body
            .filter((c) => c.page === l.page && Math.abs(c.y - l.y) < 6 && c.x > 265 && /^\d+(,\d+)?%$/.test(c.text))
            .sort((x, y) => x.x - y.x)
            .map((c) => c.text);
        const tokens = embedded ? [embedded, ...cells] : cells;
        const row: (string | null)[] = tokens.length === LAW_COLUMNS ? tokens : [null];
        if (row.some((v) => v === null)) throw new Error(`ley, pág. ${l.page}: fila ${code} sin 8 tasas legibles`);
        const rates = (row as string[]).map((v) => n(v.replace(",", ".").replace(/%$/, "")));
        const prev = table.get(code);
        if (prev && JSON.stringify(prev) !== JSON.stringify(rates)) throw new Error(`ley: fila ${code} repetida con tasas distintas`);
        table.set(code, rates);
    }
    return table;
}

/**
 * Tramos (filas N sin artículo especial) cubriendo [0, ∞) sin huecos. Sin filas
 * N, la alícuota general (G) es la única. `overlaps` informa los tramos que la
 * exportación hace empezar EN el tope anterior (y no un centavo después): la ley
 * dice «no supere», así que ese importe corresponde al tramo inferior.
 */
export function tiersOf(rows: readonly ArbaRateRow[], overlaps: string[] = []): ArbaRateRow[] {
    const reduced = rows.filter((r) => r.rateType === "N" && !(r.article ?? "").startsWith("Art"));
    if (reduced.length === 0) {
        const g = rows.filter((r) => r.rateType === "G");
        if (g.length !== 1) throw new Error(`código ${rows[0]?.code}: sin tramos ni una única alícuota general`);
        return [{ ...g[0], lowerAmount: "0", upperAmount: null }];
    }
    const sorted = reduced.sort((a, b) => compareMoney(a.lowerAmount, b.lowerAmount));
    // Fila duplicada: empieza en un tope y tiene una gemela (misma tasa y tope) que empieza un centavo después.
    const centAfter = (x: string) => {
        const [int, frac = ""] = x.split(".");
        if (frac !== "") return null;
        return `${int}.01`;
    };
    const tiers = sorted.filter((t) => {
        const twin = sorted.find((u) => u !== t && centAfter(t.lowerAmount) !== null && compareMoney(u.lowerAmount, centAfter(t.lowerAmount)!) === 0 && u.rate === t.rate && u.upperAmount === t.upperAmount);
        if (twin && t.lowerAmount !== "0") {
            overlaps.push(`código ${t.code}: fila duplicada del tramo desde ${t.lowerAmount} (gemela desde ${twin.lowerAmount}, misma alícuota ${t.rate} %); se descarta`);
            return false;
        }
        return true;
    });
    let expectedLower = "0";
    let prevCap: string | null = null;
    for (const [i, t] of tiers.entries()) {
        if (prevCap !== null && compareMoney(t.lowerAmount, prevCap) === 0) overlaps.push(`código ${t.code}: tramo que empieza en ${prevCap} (debería ser ${expectedLower}); se aplica «no supere»`);
        else if (compareMoney(t.lowerAmount, expectedLower) !== 0) throw new Error(`código ${t.code}: tramo con inicio ${t.lowerAmount}, se esperaba ${expectedLower}`);
        const last = i === tiers.length - 1;
        if (last !== (t.upperAmount === null || t.upperAmount === "9999999999999.99")) throw new Error(`código ${t.code}: tope del último tramo inesperado`);
        if (!last) {
            if (!(TRAMO_CAPS as readonly string[]).includes(t.upperAmount!)) throw new Error(`código ${t.code}: tope ${t.upperAmount} no es un tope del art. 20`);
            const [int, frac = ""] = t.upperAmount!.split(".");
            if (frac !== "") throw new Error(`código ${t.code}: tope con decimales`);
            expectedLower = `${int}.01`;
            prevCap = t.upperAmount;
        }
    }
    if (tiers.length === 0) throw new Error("sin tramos");
    return tiers;
}

/** Tasa que resulta de los tramos para un ingreso dado. */
function rateAt(tiers: readonly ArbaRateRow[], income: string): string {
    // Primer tramo cuyo tope no se supera («no supere»): resuelve también los solapes en el tope.
    const t = tiers.find((x) => x.upperAmount === null || x.upperAmount === "9999999999999.99" || compareMoney(income, x.upperAmount) <= 0);
    return n(t!.rate);
}

/** Contraste: para cada código, general (ingreso > tope del tramo 1) y tramos 1 a 7 (ingreso = tope) contra la ley. */
export function contrastWithLaw(code: string, tiers: readonly ArbaRateRow[], law: ReadonlyMap<string, string[]>): string | null {
    const row = law.get(code) ?? law.get(code.slice(0, 4));
    if (!row) return `código ${code}: sin fila (código ni clase) en la tabla del art. 20`;
    const probes = [`${TRAMO_CAPS[0]}.01`, ...TRAMO_CAPS];
    for (const [i, income] of probes.entries()) {
        const got = rateAt(tiers, income);
        if (got !== n(row[i])) return `código ${code}: ${i === 0 ? "general" : `tramo ${i}`} exportación ${got} % / ley ${row[i]} %`;
    }
    return null;
}

const COMMON: RuleCondition[] = [
    {
        kind: "DECLARED_FACT",
        factKey: "pbaSinExencion",
        expected: true,
        description: "La actividad no está comprendida en beneficios de exención del Código Fiscal o de leyes especiales (art. 20, Ley 15.558)",
    },
    {
        kind: "DECLARED_FACT",
        factKey: "pbaNoInicioEnEjercicio",
        expected: true,
        description: "El contribuyente no inició actividades en el ejercicio en curso (en ese caso rigen los umbrales de los dos primeros meses, art. 20)",
    },
];

const incomeCondition = (minExclusive: string | null, maxInclusive: string | null): RuleCondition => ({
    kind: "PRIOR_YEAR_GROSS_INCOME",
    minExclusive,
    maxInclusive,
    description: `Total de ingresos gravados, no gravados y exentos del período fiscal anterior, por cualquier actividad dentro o fuera de la Provincia, ${
        maxInclusive !== null ? `de hasta $${maxInclusive}${minExclusive !== null ? ` y mayor a $${minExclusive}` : ""}` : `mayor a $${minExclusive}`
    } (art. 20, Ley 15.558)`,
});

export function buildArbaRules(rates: readonly ArbaRateRow[], law: ReadonlyMap<string, string[]>, catalogCodes: ReadonlySet<string>) {
    const byCode = new Map<string, ArbaRateRow[]>();
    for (const r of rates.filter((x) => x.periodFrom === "2026-01")) {
        if (r.periodTo !== "2026-12") throw new Error(`código ${r.code}: período 2026 que no termina en 202612`);
        byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
    }
    const groups = new Map<string, { rule: Omit<RateRule, "activityCodes">; codes: string[] }>();
    const problems: string[] = [];
    const overlaps: string[] = [];
    const held = new Set<string>();
    for (const [code, rows] of [...byCode].sort(([a], [b]) => a.localeCompare(b))) {
        if (!catalogCodes.has(code)) {
            problems.push(`código ${code}: no está en el catálogo NAIIB-18`);
            continue;
        }
        let tiers: ArbaRateRow[];
        try {
            tiers = tiersOf(rows, overlaps);
        } catch (e) {
            problems.push((e as Error).message);
            continue;
        }
        const mismatch = contrastWithLaw(code, tiers, law);
        if (mismatch) {
            problems.push(mismatch);
            continue;
        }
        const special = rows.filter((r) => (r.article ?? "").startsWith("Art"));
        const unknownFlags = rows.some((r) => r.bonification) || rows.some((r) => r.rateSUS !== null);
        const hold = unknownFlags
            ? "Exportación de ARBA con bonif_actiba = S o AlicuotaSUS: campos sin definición normativa verificada; confirmar si alteran la alícuota."
            : special.length > 0
              ? `Además de los tramos, ARBA publica un tratamiento especial (${special.map((s) => `${s.article} ${n(s.rate)} %`).join(", ")}): confirmar cómo se excluyen mutuamente.`
              : undefined;
        if (hold) held.add(code);
        let prevCap: string | null = null;
        for (const t of tiers) {
            const cap = t.upperAmount === null || t.upperAmount === "9999999999999.99" ? null : t.upperAmount;
            const single = tiers.length === 1;
            const key = `${n(t.rate)}|${single ? "única" : `${prevCap}|${cap}`}|${hold ?? ""}`;
            const id = `t${n(t.rate).replace(".", "_")}-${single ? "unica" : `${prevCap ?? "0"}-${cap ?? "max"}`}${hold ? `-h${[...hold].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}` : ""}`;
            const g = groups.get(key) ?? {
                rule: {
                    id,
                    registrations: ["LOCAL", "CONVENIO_MULTILATERAL"],
                    validFrom: null,
                    validTo: null,
                    treatment: "RATE",
                    rate: n(t.rate),
                    conditions: single ? [...COMMON] : [...COMMON, incomeCondition(prevCap, cap)],
                    legalReference: `Ley 15.558, art. 20 (tabla por clase/código NAIIB-18; ${single ? "alícuota general, sin tramos reducidos" : (t.article ?? "tramo superior: alícuota general")})`,
                    ...(hold ? { pendingInterpretation: hold } : {}),
                },
                codes: [],
            };
            g.codes.push(code);
            groups.set(key, g);
            prevCap = cap;
        }
    }
    const rules: RateRule[] = [...groups.values()].map((g) => ({ ...g.rule, activityCodes: g.codes }));
    return { rules, problems, overlaps, held: [...held].sort(), codes: byCode.size };
}

export function arba2026Main(argv: string[]): number {
    const a = parseArgs(argv);
    const req = (k: string) => required(a, k);
    const alic = readTsvLatin1(readFileSync(req("alicuotaria")), ALICUOTARIA_HEADER);
    const catalog = JSON.parse(readFileSync(req("catalog"), "utf8")) as CatalogFile;
    if (catalog.manifest.jurisdiction !== "902") throw new Error("se espera el catálogo NAIIB-18 (902)");
    const law = readLawTable(parsePdfLines(readFileSync(req("law-lines"), "utf8")));
    const { rules, problems, overlaps, held, codes } = buildArbaRules(arbaRates(alic).rows, law, new Set(catalog.entries.map((e) => e.code)));
    console.log(`${law.size} filas de la ley; ${codes} códigos con alícuotas 2026; ${rules.length} reglas; ${held.length} códigos retenidos; ${problems.length} códigos sin regla`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log(`${overlaps.length} solapes en topes de la exportación (resueltos por «no supere»):`);
    for (const o of overlaps) console.log(`  - ${o}`);
    const set: RateRuleSet = {
        manifest: {
            id: SET_ID,
            jurisdiction: "902",
            nomenclator: "PROVINCIAL",
            catalogIds: [catalog.manifest.id],
            organism: "Legislatura de la Provincia de Buenos Aires / ARBA",
            norm: "Ley 15.558 (Impositiva 2026), art. 20",
            sourceUrl: LAW_URL,
            publishedAt: "2025-12-15",
            consultedAt: req("consulted"),
            version: "Ley 15.558, tabla del art. 20, contrastada con la exportación alicuotaria de ARBA",
            validFrom: "2026-01-01",
            validTo: "2026-12-31",
            sourceSha256: sha256Hex(readFileSync(req("law-pdf"))),
            review: pendingReview(RULES_REVIEW_LEVELS),
        },
        rules,
    };
    const invalid = validateRuleSet(set);
    if (invalid.length > 0) {
        console.error(`CONJUNTO RECHAZADO:\n- ${invalid.slice(0, 20).join("\n- ")}`);
        return 2;
    }
    writeFileSync(req("out"), `${JSON.stringify(set, null, 1)}\n`, { flag: "wx" });
    console.log(`escrito ${req("out")} en estado PENDIENTE_REVISION.`);
    return 0;
}
