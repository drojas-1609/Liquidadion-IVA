/**
 * Revisión por niveles de un catálogo (`data/activity-catalogs/*.json`) o de un
 * conjunto de reglas (`data/iibb-rate-rules/*.json`). Ver lib/activity-catalog/review.ts.
 *
 * Decisión del ESTUDIO sobre un nivel (technical, validity o, en reglas, interpretation):
 *   cli.ts -- review --file <archivo> --level <nivel> --decision CONFORME|OBSERVADO|PENDIENTE \
 *     --reviewer "<nombre o rol>" --date AAAA-MM-DD [--notes "..."]
 *
 * Aprobación final del ESTUDIO (sólo con todos los niveles CONFORME):
 *   cli.ts -- approve --file <archivo> --reviewer "<nombre o rol>" --date AAAA-MM-DD [--notes "..."]
 *
 * Resultado del PREPARADOR (cotejo o investigación; no es una decisión):
 *   cli.ts -- add-check --file <archivo> --level <nivel> --kind AUTOMATICO|INVESTIGACION \
 *     --result SIN_DIFERENCIAS|CON_DIFERENCIAS|INFORMATIVO --date AAAA-MM-DD --summary "..." \
 *     --evidence "<ruta relativa al directorio de evidencia o URL>" [--evidence ...]
 *
 * Antes de escribir revalida estructura y checksums; nunca toca entradas ni reglas.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { integrityProblems } from "../../lib/activity-catalog/checksum";
import { validateCatalogFile } from "../../lib/activity-catalog/validate";
import {
    CATALOG_REVIEW_LEVELS,
    CHECK_KINDS,
    CHECK_RESULTS,
    LEVEL_DECISIONS,
    RULES_REVIEW_LEVELS,
    addPreparerCheck,
    approveReview,
    recordLevelDecision,
    type LevelDecision,
    type PreparerCheck,
    type ReviewInfo,
    type ReviewLevelName,
} from "../../lib/activity-catalog/review";
import type { CatalogFile } from "../../lib/activity-catalog/types";
import { validateRuleSet } from "../../lib/iibb-rates/validate";
import type { RateRuleSet } from "../../lib/iibb-rates/types";

export type ReviewableFile = CatalogFile | RateRuleSet;

const isRuleSet = (f: ReviewableFile): f is RateRuleSet => Array.isArray((f as RateRuleSet).rules);

export function levelsOf(f: ReviewableFile): readonly ReviewLevelName[] {
    return isRuleSet(f) ? RULES_REVIEW_LEVELS : CATALOG_REVIEW_LEVELS;
}

function problemsOf(f: ReviewableFile): string[] {
    return isRuleSet(f) ? validateRuleSet(f) : [...validateCatalogFile(f), ...integrityProblems(f)];
}

function withReview<T extends ReviewableFile>(f: T, change: (r: ReviewInfo, levels: readonly ReviewLevelName[]) => ReviewInfo): T {
    const before = problemsOf(f);
    if (before.length > 0) throw new Error(`el archivo no es válido: ${before.slice(0, 5).join("; ")}`);
    const next = { ...f, manifest: { ...f.manifest, review: change(f.manifest.review, levelsOf(f)) } } as T;
    const after = problemsOf(next);
    if (after.length > 0) throw new Error(`resultado inválido: ${after.slice(0, 5).join("; ")}`);
    return next;
}

export function decideLevel<T extends ReviewableFile>(f: T, level: ReviewLevelName, decision: LevelDecision, reviewer: string, date: string, notes: string | null): T {
    return withReview(f, (r, levels) => recordLevelDecision(r, levels, level, decision, reviewer, date, notes));
}

export function approve<T extends ReviewableFile>(f: T, reviewer: string, date: string, notes: string | null): T {
    return withReview(f, (r, levels) => approveReview(r, levels, reviewer, date, notes));
}

export function addCheck<T extends ReviewableFile>(f: T, level: ReviewLevelName, check: PreparerCheck): T {
    return withReview(f, (r, levels) => addPreparerCheck(r, levels, level, check));
}

function args(argv: string[]): { get: (k: string) => string | undefined; all: (k: string) => string[] } {
    const a = argv.filter((x) => x !== "--");
    return {
        get: (k) => {
            const i = a.indexOf(`--${k}`);
            return i >= 0 ? a[i + 1] : undefined;
        },
        all: (k) => a.flatMap((x, i) => (x === `--${k}` && a[i + 1] !== undefined ? [a[i + 1]] : [])),
    };
}

const need = (v: string | undefined, k: string) => {
    if (!v) throw new Error(`falta --${k}`);
    return v;
};

function rewrite(path: string, change: (f: ReviewableFile) => ReviewableFile): void {
    const f = JSON.parse(readFileSync(path, "utf8")) as ReviewableFile;
    writeFileSync(path, `${JSON.stringify(change(f), null, 1)}\n`);
}

/** `cli.ts review`: decisión del estudio sobre un nivel. */
export function reviewMain(argv: string[]): number {
    const { get } = args(argv);
    const path = need(get("file"), "file");
    const level = need(get("level"), "level") as ReviewLevelName;
    const decision = need(get("decision"), "decision") as LevelDecision;
    if (!(LEVEL_DECISIONS as readonly string[]).includes(decision)) throw new Error(`--decision debe ser ${LEVEL_DECISIONS.join(", ")}`);
    rewrite(path, (f) => decideLevel(f, level, decision, need(get("reviewer"), "reviewer"), need(get("date"), "date"), get("notes") ?? null));
    console.log(`${path}: nivel ${level} = ${decision}`);
    return 0;
}

/** `cli.ts approve`: aprobación final del estudio. */
export function approveMain(argv: string[]): number {
    const { get } = args(argv);
    const path = need(get("file"), "file");
    rewrite(path, (f) => approve(f, need(get("reviewer"), "reviewer"), need(get("date"), "date"), get("notes") ?? null));
    console.log(`${path}: REVISADO (todos los niveles CONFORME)`);
    return 0;
}

/** `cli.ts add-check`: resultado del preparador, sin decisión. */
export function addCheckMain(argv: string[]): number {
    const { get, all } = args(argv);
    const path = need(get("file"), "file");
    const kind = need(get("kind"), "kind") as PreparerCheck["kind"];
    const result = need(get("result"), "result") as PreparerCheck["result"];
    if (!(CHECK_KINDS as readonly string[]).includes(kind)) throw new Error(`--kind debe ser ${CHECK_KINDS.join(", ")}`);
    if (!(CHECK_RESULTS as readonly string[]).includes(result)) throw new Error(`--result debe ser ${CHECK_RESULTS.join(", ")}`);
    const check: PreparerCheck = { kind, result, at: need(get("date"), "date"), summary: need(get("summary"), "summary"), evidence: all("evidence") };
    rewrite(path, (f) => addCheck(f, need(get("level"), "level") as ReviewLevelName, check));
    console.log(`${path}: check agregado al nivel ${get("level")}`);
    return 0;
}
