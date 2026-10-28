/**
 * Revisión POR NIVELES de catálogos y conjuntos de reglas. Ninguna marca única
 * de «revisado» oculta diferencias entre niveles:
 *
 *  - technical:      integridad técnica y cotejo de códigos/descripciones (o
 *                    de tasas) contra la fuente.
 *  - validity:       vigencia normativa (versión vigente, modificaciones,
 *                    derogaciones, fechas de aplicación).
 *  - interpretation: sólo reglas de alícuotas; lectura de la norma que se
 *                    convierte en reglas (alcance, condiciones, exclusiones).
 *
 * Cada nivel tiene la DECISIÓN del estudio (PENDIENTE / OBSERVADO / CONFORME,
 * con revisor y fecha) y, aparte, los `checks` del preparador: resultados de
 * cotejos automáticos o de investigación con su evidencia. Un check nunca
 * cambia la decisión.
 *
 * Publicación: `status = REVISADO` sólo si TODOS los niveles requeridos están
 * CONFORME; la aprobación final también la registra una persona del estudio.
 *
 * Puro: apto para cliente y servidor.
 */

export const REVIEW_STATUSES = ["PENDIENTE_REVISION", "REVISADO", "RECHAZADO"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_LEVEL_NAMES = ["technical", "validity", "interpretation"] as const;
export type ReviewLevelName = (typeof REVIEW_LEVEL_NAMES)[number];

export const CATALOG_REVIEW_LEVELS: readonly ReviewLevelName[] = ["technical", "validity"];
export const RULES_REVIEW_LEVELS: readonly ReviewLevelName[] = ["technical", "validity", "interpretation"];

export const REVIEW_LEVEL_LABEL: Readonly<Record<ReviewLevelName, string>> = {
    technical: "Integridad técnica y cotejo con la fuente",
    validity: "Vigencia normativa",
    interpretation: "Interpretación de las reglas",
};

export const LEVEL_DECISIONS = ["PENDIENTE", "OBSERVADO", "CONFORME"] as const;
export type LevelDecision = (typeof LEVEL_DECISIONS)[number];

export const CHECK_KINDS = ["AUTOMATICO", "INVESTIGACION"] as const;
export const CHECK_RESULTS = ["SIN_DIFERENCIAS", "CON_DIFERENCIAS", "INFORMATIVO"] as const;

/** Resultado del PREPARADOR (no es una aprobación). */
export interface PreparerCheck {
    kind: (typeof CHECK_KINDS)[number];
    at: string;
    result: (typeof CHECK_RESULTS)[number];
    summary: string;
    /** Rutas relativas al directorio de evidencia (con sha256) o URLs oficiales. */
    evidence: string[];
}

export interface ReviewLevel {
    status: LevelDecision;
    reviewedBy: string | null;
    reviewedAt: string | null;
    notes: string | null;
    checks: PreparerCheck[];
}

export interface ReviewInfo {
    status: ReviewStatus;
    /** Aprobación final del estudio; null mientras esté pendiente. */
    reviewedBy: string | null;
    reviewedAt: string | null;
    notes: string | null;
    levels: Partial<Record<ReviewLevelName, ReviewLevel>>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(v: unknown): v is string {
    if (typeof v !== "string" || !ISO_DATE.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function pendingLevel(checks: PreparerCheck[] = []): ReviewLevel {
    return { status: "PENDIENTE", reviewedBy: null, reviewedAt: null, notes: null, checks };
}

export function pendingReview(required: readonly ReviewLevelName[]): ReviewInfo {
    return { status: "PENDIENTE_REVISION", reviewedBy: null, reviewedAt: null, notes: null, levels: Object.fromEntries(required.map((l) => [l, pendingLevel()])) };
}

/** Problemas de estructura y coherencia de la revisión (vacío = válida). */
export function validateReview(raw: unknown, required: readonly ReviewLevelName[]): string[] {
    const p: string[] = [];
    if (typeof raw !== "object" || raw === null) return ["estado de revisión inválido"];
    const r = raw as Partial<ReviewInfo>;
    if (!(REVIEW_STATUSES as readonly string[]).includes(r.status as string)) return ["estado de revisión inválido"];
    if (typeof r.levels !== "object" || r.levels === null) return ["la revisión no tiene niveles"];
    const names = Object.keys(r.levels);
    for (const n of names) if (!required.includes(n as ReviewLevelName)) p.push(`nivel de revisión no admitido: ${n}`);
    for (const n of required) {
        const l = r.levels[n];
        if (!l) {
            p.push(`falta el nivel de revisión ${n}`);
            continue;
        }
        if (!(LEVEL_DECISIONS as readonly string[]).includes(l.status)) p.push(`nivel ${n}: decisión inválida`);
        else if (l.status === "PENDIENTE" && (l.reviewedBy !== null || l.reviewedAt !== null)) p.push(`nivel ${n}: pendiente sin revisor ni fecha`);
        else if (l.status !== "PENDIENTE" && (!nonEmpty(l.reviewedBy) || !isIsoDate(l.reviewedAt))) p.push(`nivel ${n}: la decisión requiere revisor y fecha`);
        if (l.status === "OBSERVADO" && !nonEmpty(l.notes)) p.push(`nivel ${n}: una observación requiere notas`);
        if (!Array.isArray(l.checks)) p.push(`nivel ${n}: checks inválidos`);
        else
            l.checks.forEach((c, i) => {
                const at = `nivel ${n}, check ${i + 1}`;
                if (!(CHECK_KINDS as readonly string[]).includes(c?.kind)) p.push(`${at}: tipo inválido`);
                if (!(CHECK_RESULTS as readonly string[]).includes(c?.result)) p.push(`${at}: resultado inválido`);
                if (!isIsoDate(c?.at)) p.push(`${at}: fecha inválida`);
                if (!nonEmpty(c?.summary)) p.push(`${at}: falta el resumen`);
                if (!Array.isArray(c?.evidence) || !c.evidence.every(nonEmpty)) p.push(`${at}: evidencia inválida`);
            });
    }
    if (r.status === "PENDIENTE_REVISION" && (r.reviewedBy !== null || r.reviewedAt !== null)) p.push("una revisión pendiente no lleva aprobador ni fecha");
    if (r.status !== "PENDIENTE_REVISION" && (!nonEmpty(r.reviewedBy) || !isIsoDate(r.reviewedAt))) p.push(`${r.status} requiere aprobador y fecha`);
    if (r.status === "REVISADO" && required.some((n) => r.levels?.[n]?.status !== "CONFORME")) p.push("REVISADO requiere todos los niveles CONFORME");
    return p;
}

/** Publicable: aprobado y con todos los niveles requeridos CONFORME. */
export function isApproved(review: ReviewInfo | undefined, required: readonly ReviewLevelName[]): boolean {
    return review?.status === "REVISADO" && required.every((n) => review.levels?.[n]?.status === "CONFORME");
}

/** Decisión del estudio sobre UN nivel. Una decisión nueva sobre un conjunto ya aprobado lo devuelve a pendiente. */
export function recordLevelDecision(
    review: ReviewInfo,
    required: readonly ReviewLevelName[],
    level: ReviewLevelName,
    decision: LevelDecision,
    reviewer: string,
    date: string,
    notes: string | null,
): ReviewInfo {
    if (!required.includes(level)) throw new Error(`el nivel ${level} no corresponde a este tipo de archivo`);
    if (review.status === "RECHAZADO") throw new Error("el archivo está RECHAZADO: importar o generar una versión nueva");
    const prev = review.levels[level] ?? pendingLevel();
    const levels = { ...review.levels, [level]: { ...prev, status: decision, reviewedBy: decision === "PENDIENTE" ? null : reviewer.trim(), reviewedAt: decision === "PENDIENTE" ? null : date, notes } };
    const next: ReviewInfo = { ...review, status: "PENDIENTE_REVISION", reviewedBy: null, reviewedAt: null, notes: review.status === "REVISADO" ? null : review.notes, levels };
    const problems = validateReview(next, required);
    if (problems.length > 0) throw new Error(`decisión inválida: ${problems.join("; ")}`);
    return next;
}

/** Aprobación final: sólo con todos los niveles CONFORME. */
export function approveReview(review: ReviewInfo, required: readonly ReviewLevelName[], reviewer: string, date: string, notes: string | null): ReviewInfo {
    if (review.status !== "PENDIENTE_REVISION") throw new Error(`estado actual ${review.status}: sólo se aprueba una revisión pendiente`);
    const missing = required.filter((n) => review.levels[n]?.status !== "CONFORME");
    if (missing.length > 0) throw new Error(`niveles sin CONFORME: ${missing.join(", ")}`);
    const next: ReviewInfo = { ...review, status: "REVISADO", reviewedBy: reviewer.trim(), reviewedAt: date, notes };
    const problems = validateReview(next, required);
    if (problems.length > 0) throw new Error(`aprobación inválida: ${problems.join("; ")}`);
    return next;
}

/** Agrega un resultado del preparador a un nivel (no cambia la decisión). */
export function addPreparerCheck(review: ReviewInfo, required: readonly ReviewLevelName[], level: ReviewLevelName, check: PreparerCheck): ReviewInfo {
    if (!required.includes(level)) throw new Error(`el nivel ${level} no corresponde a este tipo de archivo`);
    const prev = review.levels[level] ?? pendingLevel();
    const next: ReviewInfo = { ...review, levels: { ...review.levels, [level]: { ...prev, checks: [...prev.checks, check] } } };
    const problems = validateReview(next, required);
    if (problems.length > 0) throw new Error(`check inválido: ${problems.join("; ")}`);
    return next;
}
