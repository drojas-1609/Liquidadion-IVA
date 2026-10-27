/**
 * Cotejo de una versión importada (desde la planilla oficial) contra el TEXTO
 * del anexo en PDF de la misma norma. Sirve de evidencia para la revisión
 * humana: no corrige nada ni marca la versión como revisada.
 *
 * El texto se extrae fuera de este script (macOS, PDFKit, sin dependencias):
 *
 *   swiftc -O -o /tmp/pdftext scripts/activity-catalogs/pdftext.swift
 *   /tmp/pdftext <anexo.pdf> > anexo.txt
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- crosscheck \
 *     --file data/activity-catalogs/<id>.json --text anexo.txt \
 *     [--from "<texto donde empieza el anexo>"] [--until "<texto donde termina>"]
 *
 * Comprueba, en el orden del catálogo:
 *  - que cada código aparezca al comienzo de una línea, en el mismo orden;
 *  - que no haya en el tramo códigos al comienzo de línea ausentes del catálogo;
 *  - que la descripción esté en el bloque del código como sucesión de líneas
 *    (el PDF parte las celdas y puede intercalar otras columnas; la última
 *    parte puede compartir línea con el texto de «Incluye»);
 *  - que las vigencias MM/AAAA del bloque coincidan con las de la entrada.
 */
import { readFileSync } from "node:fs";
import type { CatalogEntry, CatalogFile } from "../../lib/activity-catalog/types";

export interface CrosscheckReport {
    checked: number;
    missingCodes: string[];
    extraCodes: string[];
    descriptionMismatches: string[];
    validityMismatches: { code: string; expected: string; found: string }[];
}

const compact = (s: string) => s.replace(/\s+/g, "");

/** AAAA-MM-DD -> MM/AAAA, como lo publica el anexo. */
const monthYear = (iso: string | null | undefined) => (iso ? `${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);

function descriptionInBlock(description: string, block: string): boolean {
    let rest = compact(description);
    for (const line of block.split("\n")) {
        const l = compact(line);
        if (!l) continue;
        // La descripción puede terminar a mitad de línea, seguida del «Incluye».
        if (l.startsWith(rest)) return true;
        if (rest.startsWith(l)) rest = rest.slice(l.length);
    }
    return false;
}

export function crosscheckAgainstText(entries: readonly CatalogEntry[], text: string): CrosscheckReport {
    const report: CrosscheckReport = { checked: entries.length, missingCodes: [], extraCodes: [], descriptionMismatches: [], validityMismatches: [] };
    const starts: number[] = [];
    let pos = 0;
    for (const e of entries) {
        const re = new RegExp(`^${e.code.replace(/\./g, "\\.")}(?=\\s|$)`, "gm");
        re.lastIndex = pos;
        const m = re.exec(text);
        if (!m) {
            report.missingCodes.push(e.code);
            starts.push(-1);
            continue;
        }
        starts.push(m.index);
        pos = m.index + e.code.length;
    }
    const known = new Set(entries.map((e) => e.code));
    const lineCodes = new Set([...text.matchAll(/^(\d{6})(?=\s|$)/gm)].map((m) => m[1]));
    report.extraCodes = [...lineCodes].filter((c) => !known.has(c)).sort();

    entries.forEach((e, i) => {
        if (starts[i] < 0) return;
        const next = starts.slice(i + 1).find((s) => s >= 0);
        const block = text.slice(starts[i] + e.code.length, next);
        if (!descriptionInBlock(e.description, block)) report.descriptionMismatches.push(e.code);
        if (e.validFrom === undefined && e.validTo === undefined) return;
        const found = [...block.matchAll(/\b(?:0[1-9]|1[0-2])\/(?:19|20)\d\d\b/g)].map((m) => m[0]).join(" ");
        const expected = [monthYear(e.validFrom), monthYear(e.validTo)].filter(Boolean).join(" ");
        if (found !== expected) report.validityMismatches.push({ code: e.code, expected, found });
    });
    return report;
}

/** Recorta el texto entre dos marcas (la última aparición de `from`, para saltear el articulado). */
export function sliceSection(text: string, from: string | null, until: string | null): string {
    let out = text;
    if (from) {
        const i = out.lastIndexOf(from);
        if (i < 0) throw new Error(`no se encontró --from "${from}"`);
        out = out.slice(i);
    }
    if (until) {
        const j = out.indexOf(until);
        if (j < 0) throw new Error(`no se encontró --until "${until}"`);
        out = out.slice(0, j);
    }
    return out;
}

/** Punto de entrada de `cli.ts crosscheck`. 0 = sin diferencias. */
export function crosscheckMain(argv: string[]): number {
    const args = argv.filter((x) => x !== "--");
    const get = (k: string) => {
        const i = args.indexOf(`--${k}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const file = get("file");
    const textPath = get("text");
    if (!file || !textPath) throw new Error('uso: --file <catálogo.json> --text <anexo.txt> [--from "<marca>"] [--until "<marca>"]');
    const catalog = JSON.parse(readFileSync(file, "utf8")) as CatalogFile;
    const text = sliceSection(readFileSync(textPath, "utf8"), get("from") ?? null, get("until") ?? null);
    const r = crosscheckAgainstText(catalog.entries, text);
    console.log(`${catalog.manifest.id}: ${r.checked} entradas cotejadas contra ${textPath}`);
    console.log(`- códigos no hallados en orden: ${r.missingCodes.length} ${r.missingCodes.slice(0, 20).join(" ")}`);
    console.log(`- códigos del PDF ausentes del catálogo: ${r.extraCodes.length} ${r.extraCodes.slice(0, 20).join(" ")}`);
    console.log(`- descripciones no halladas: ${r.descriptionMismatches.length} ${r.descriptionMismatches.slice(0, 20).join(" ")}`);
    console.log(`- vigencias distintas: ${r.validityMismatches.length}`);
    for (const v of r.validityMismatches.slice(0, 20)) console.log(`  ${v.code}: esperado "${v.expected}", PDF "${v.found}"`);
    const total = r.missingCodes.length + r.extraCodes.length + r.descriptionMismatches.length + r.validityMismatches.length;
    return total === 0 ? 0 : 3;
}
