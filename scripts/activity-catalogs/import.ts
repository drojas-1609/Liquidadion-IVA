/**
 * Importación REPRODUCIBLE de un catálogo oficial de actividades desde una
 * planilla descargada a mano de la fuente oficial (este script no descarga
 * nada ni se conecta a ninguna base).
 *
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- import \
 *     --source <archivo.xlsx> --sheet "<hoja>" \
 *     --code-header "<encabezado código>" --description-header "<encabezado descripción>" \
 *     [--reference-header "<encabezado referencia>"] [--code-length 6] \
 *     [--valid-from-header "<encabezado inicio>" --valid-to-header "<encabezado fin>"] \
 *     --id naes-rg-ca-19-2025 --nomenclator NAES [--jurisdiction 901] \
 *     --name "..." --organism "..." --norm "..." --version "..." \
 *     --source-url https://... --published AAAA-MM-DD --consulted AAAA-MM-DD \
 *     --valid-from AAAA-MM-DD [--valid-to AAAA-MM-DD] [--supersedes <id>] \
 *     --out data/activity-catalogs/<id>.json
 *
 * Garantías:
 *  - El resultado queda SIEMPRE en estado PENDIENTE_REVISION: una descarga nueva
 *    no se publica como vigente sin una revisión humana (scripts/.../review.ts).
 *  - Nunca sobrescribe: si el archivo de salida existe, se detiene.
 *  - Los códigos se leen como TEXTO. Si la planilla los guarda como número, sólo
 *    se completan ceros a la izquierda con `--code-length` explícito, y el
 *    informe lo declara. Nada se infiere ni se completa con otra fuente.
 *  - Cualquier fila con código o descripción inválidos, o códigos duplicados,
 *    hace fallar la importación (no se descartan filas en silencio).
 *  - Vigencia por código (opcional): celdas de texto «MM/AAAA» o «AAAA-MM-DD».
 *    Un mes de inicio rige desde su día 1 y un mes de fin hasta su último día.
 *    Cualquier otro formato (incluidas fechas numéricas de Excel) es un error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { entriesSha256, sha256Hex } from "../../lib/activity-catalog/checksum";
import { validateCatalogFile } from "../../lib/activity-catalog/validate";
import { CATALOG_REVIEW_LEVELS, pendingReview } from "../../lib/activity-catalog/review";
import { normalizeSearchText } from "../../lib/activity-catalog/search";
import type { CatalogEntry, CatalogFile, CatalogNomenclator } from "../../lib/activity-catalog/types";

export interface SheetMapping {
    sheet: string;
    codeHeader: string;
    descriptionHeader: string;
    referenceHeader: string | null;
    codeLength: number | null;
    /** Columnas de vigencia por código; ambas o ninguna. */
    validFromHeader?: string | null;
    validToHeader?: string | null;
}

export interface ImportReport {
    entries: CatalogEntry[];
    paddedCodes: number;
    headerRow: number;
}

const norm = (s: unknown) => normalizeSearchText(String(s ?? ""));

/** «MM/AAAA» o «AAAA-MM-DD» -> AAAA-MM-DD; el mes de fin se lleva a su último día. */
export function parseEntryDate(raw: string, edge: "from" | "to"): string {
    const s = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = /^(0[1-9]|1[0-2])\/(\d{4})$/.exec(s);
    if (!m) throw new Error(`fecha de vigencia no reconocida: "${s}" (se espera MM/AAAA o AAAA-MM-DD)`);
    const [month, year] = [Number(m[1]), Number(m[2])];
    if (edge === "from") return `${m[2]}-${m[1]}-01`;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${m[2]}-${m[1]}-${String(last).padStart(2, "0")}`;
}

/**
 * Lee las filas de la hoja a partir del encabezado (buscado por texto
 * normalizado). Filas totalmente vacías se ignoran; una fila con datos pero sin
 * código o sin descripción es un error.
 */
export function readCatalogSheet(workbook: XLSX.WorkBook, map: SheetMapping): ImportReport {
    const ws = workbook.Sheets[map.sheet];
    if (!ws) throw new Error(`no existe la hoja "${map.sheet}" (hojas: ${workbook.SheetNames.join(", ")})`);
    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1:A1");
    const cell = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;

    let headerRow = -1;
    if (Boolean(map.validFromHeader) !== Boolean(map.validToHeader)) throw new Error("indicá ambas columnas de vigencia o ninguna");
    const withValidity = Boolean(map.validFromHeader);
    type Col = "code" | "description" | "reference" | "validFrom" | "validTo";
    const blank: Record<Col, number> = { code: -1, description: -1, reference: -1, validFrom: -1, validTo: -1 };
    const cols = { ...blank };
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 30) && headerRow < 0; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
            const t = norm(cell(r, c)?.v);
            if (t === norm(map.codeHeader)) cols.code = c;
            if (t === norm(map.descriptionHeader)) cols.description = c;
            if (map.referenceHeader && t === norm(map.referenceHeader)) cols.reference = c;
            if (map.validFromHeader && t === norm(map.validFromHeader)) cols.validFrom = c;
            if (map.validToHeader && t === norm(map.validToHeader)) cols.validTo = c;
        }
        const found = cols.code >= 0 && cols.description >= 0 && (!map.referenceHeader || cols.reference >= 0) && (!withValidity || (cols.validFrom >= 0 && cols.validTo >= 0));
        if (found) headerRow = r;
        else Object.assign(cols, blank);
    }
    if (headerRow < 0) throw new Error("no se encontró la fila de encabezados con las columnas indicadas");

    const entries: CatalogEntry[] = [];
    let paddedCodes = 0;
    for (let r = headerRow + 1; r <= range.e.r; r++) {
        const codeCell = cell(r, cols.code);
        const descCell = cell(r, cols.description);
        const refCell = cols.reference >= 0 ? cell(r, cols.reference) : undefined;
        const empty = (x?: XLSX.CellObject) => x === undefined || String(x.v ?? "").trim() === "";
        if (empty(codeCell) && empty(descCell) && empty(refCell)) continue;
        if (empty(codeCell) || empty(descCell)) throw new Error(`fila ${r + 1}: falta código o descripción`);

        let code: string;
        if (codeCell!.t === "n") {
            const asText = String(codeCell!.v);
            if (!/^\d+$/.test(asText)) throw new Error(`fila ${r + 1}: código numérico no entero (${asText})`);
            if (map.codeLength === null) throw new Error(`fila ${r + 1}: código guardado como número; indicá --code-length para conservar ceros iniciales`);
            if (asText.length > map.codeLength) throw new Error(`fila ${r + 1}: código ${asText} más largo que --code-length`);
            code = asText.padStart(map.codeLength, "0");
            if (code !== asText) paddedCodes++;
        } else {
            code = String(codeCell!.v).trim();
        }
        const description = String(descCell!.v).trim().replace(/\s+/g, " ");
        const reference = empty(refCell) ? null : String(refCell!.v).trim().replace(/\s+/g, " ");
        if (!withValidity) {
            entries.push({ code, description, reference });
            continue;
        }
        const dateOf = (c: number, edge: "from" | "to"): string | null => {
            const x = cell(r, c);
            if (empty(x)) return null;
            if (x!.t !== "s") throw new Error(`fila ${r + 1}: la vigencia debe ser texto MM/AAAA o AAAA-MM-DD (celda de tipo ${x!.t})`);
            try {
                return parseEntryDate(String(x!.v), edge);
            } catch (e) {
                throw new Error(`fila ${r + 1}: ${(e as Error).message}`);
            }
        };
        entries.push({ code, description, reference, validFrom: dateOf(cols.validFrom, "from"), validTo: dateOf(cols.validTo, "to") });
    }
    return { entries, paddedCodes, headerRow: headerRow + 1 };
}

export interface ManifestArgs {
    id: string;
    nomenclator: CatalogNomenclator;
    jurisdiction: string | null;
    name: string;
    organism: string;
    norm: string;
    version: string;
    sourceUrl: string;
    sourceFile: string;
    publishedAt: string;
    consultedAt: string;
    validFrom: string;
    validTo: string | null;
    supersedes: string | null;
}

export function buildCatalogFile(sourceBytes: Uint8Array, entries: CatalogEntry[], a: ManifestArgs): CatalogFile {
    return {
        manifest: {
            ...a,
            sourceSha256: sha256Hex(sourceBytes),
            entriesSha256: entriesSha256(entries),
            entryCount: entries.length,
            review: pendingReview(CATALOG_REVIEW_LEVELS),
        },
        entries,
    };
}

export function parseArgs(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === "--") continue;
        if (!k.startsWith("--")) throw new Error(`argumento inesperado: ${k}`);
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`falta el valor de ${k}`);
        out[k.slice(2)] = v;
        i++;
    }
    return out;
}

/** Argumento obligatorio de la línea de comandos. */
export function required(a: Record<string, string>, k: string): string {
    if (!a[k]) throw new Error(`falta --${k}`);
    return a[k];
}

/** Datos del manifiesto comunes a todos los importadores (`--id`, `--norm`, fechas...). */
export function manifestArgsFrom(a: Record<string, string>, sourcePath: string): ManifestArgs {
    const req = (k: string) => required(a, k);
    return {
        id: req("id"),
        nomenclator: req("nomenclator") as CatalogNomenclator,
        jurisdiction: a.jurisdiction ?? null,
        name: req("name"),
        organism: req("organism"),
        norm: req("norm"),
        version: req("version"),
        sourceUrl: req("source-url"),
        sourceFile: sourcePath.split("/").pop()!,
        publishedAt: req("published"),
        consultedAt: req("consulted"),
        validFrom: req("valid-from"),
        validTo: a["valid-to"] ?? null,
        supersedes: a.supersedes ?? null,
    };
}

/** Valida y escribe (sin sobrescribir) una versión importada. Devuelve el código de salida. */
export function writeImported(file: CatalogFile, out: string): number {
    const problems = validateCatalogFile(file);
    if (problems.length > 0) {
        console.error(`IMPORTACIÓN RECHAZADA (${problems.length} problemas):\n- ${problems.slice(0, 30).join("\n- ")}`);
        return 2;
    }
    writeFileSync(out, `${JSON.stringify(file, null, 1)}\n`, { flag: "wx" });
    console.log(`escrito ${out} en estado PENDIENTE_REVISION (sha256 fuente ${file.manifest.sourceSha256}).`);
    console.log("Siguiente: registrar checks (`cli.ts add-check`), que el estudio decida cada nivel (`cli.ts review`) y apruebe (`cli.ts approve`); registrar en lib/activity-catalog/registry.ts.");
    return 0;
}

/** Punto de entrada de `cli.ts import`. Devuelve el código de salida. */
export function importMain(argv: string[]): number {
    const a = parseArgs(argv);
    const req = (k: string) => required(a, k);
    const bytes = readFileSync(req("source"));
    const workbook = XLSX.read(bytes, { type: "buffer", cellText: true, cellDates: false });
    const report = readCatalogSheet(workbook, {
        sheet: req("sheet"),
        codeHeader: req("code-header"),
        descriptionHeader: req("description-header"),
        referenceHeader: a["reference-header"] ?? null,
        codeLength: a["code-length"] ? Number(a["code-length"]) : null,
        validFromHeader: a["valid-from-header"] ?? null,
        validToHeader: a["valid-to-header"] ?? null,
    });
    const file = buildCatalogFile(bytes, report.entries, manifestArgsFrom(a, req("source")));
    console.log(`encabezado en la fila ${report.headerRow}; ${report.entries.length} entradas; ${report.paddedCodes} códigos completados con ceros (--code-length)`);
    return writeImported(file, req("out"));
}
