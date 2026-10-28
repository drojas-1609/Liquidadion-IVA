/**
 * Importación de un catálogo publicado SÓLO como PDF de texto con una tabla
 * «código | descripción» (p. ej. el anexo de la RG AFIP 3537/2013, CLAE F.883).
 *
 * El PDF no se interpreta aquí: primero se vuelcan sus líneas visuales con
 * posición (macOS, PDFKit, sin dependencias):
 *
 *   swiftc -O -o /tmp/pdflines scripts/activity-catalogs/pdflines.swift
 *   /tmp/pdflines <anexo.pdf> > anexo.lines
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- import-pdf-table \
 *     --pdf <anexo.pdf> --lines anexo.lines --until "<texto que cierra la tabla>" \
 *     --code-x 120:130 --description-x 155 \
 *     --id ... --nomenclator ARCA --name ... (mismo manifiesto que `import`) --out data/activity-catalogs/<id>.json
 *
 * Reglas (si alguna falla, la importación falla; nada se completa a mano):
 *  - Código: línea cuyo x inicial cae en `--code-x` y empieza con 6 dígitos.
 *  - Descripción: el texto de la misma línea visual (mismo y) a la derecha del
 *    código, uniendo los segmentos en orden de x.
 *  - Continuación: la línea inmediatamente inferior (< 13 pt) en la columna de
 *    descripción, salvo que empiece con «(» (notas «Incluye…»), tenga código
 *    propio o sea la cola de un paréntesis ajeno.
 *  - Las notas entre paréntesis no se copian.
 */
import { readFileSync } from "node:fs";
import { buildCatalogFile, manifestArgsFrom, parseArgs, required, writeImported } from "./import";
import type { CatalogEntry } from "../../lib/activity-catalog/types";

export interface PdfLine {
    page: number;
    y: number;
    x: number;
    text: string;
}

/** Formato de `pdflines.swift`: `pagina|y|x|xFin|texto`. */
export function parsePdfLines(dump: string): PdfLine[] {
    return dump
        .split("\n")
        .filter(Boolean)
        .map((l, i) => {
            const [page, y, x, , ...rest] = l.split("|");
            const out = { page: Number(page), y: Number(y), x: Number(x), text: rest.join("|").trim() };
            if (![out.page, out.y, out.x].every(Number.isFinite)) throw new Error(`línea ${i + 1} del volcado inválida`);
            return out;
        });
}

export interface PdfTableOptions {
    codeX: [number, number];
    descriptionX: number;
    /** Texto (inicio de línea) donde termina la tabla; lo posterior se ignora. */
    until: string | null;
}

const SAME_LINE = 1.5;
const NEXT_LINE = 13;
const CODE_RE = /^(\d{6})(?:\s+(.*))?$/;

const balance = (s: string) => (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;

export function readPdfTable(lines: readonly PdfLine[], o: PdfTableOptions): CatalogEntry[] {
    const end = o.until ? lines.findIndex((l) => l.text.startsWith(o.until!)) : -1;
    if (o.until && end < 0) throw new Error(`no se encontró --until "${o.until}"`);
    const body = end >= 0 ? lines.slice(0, end) : lines;
    const entries: CatalogEntry[] = [];
    for (const page of [...new Set(body.map((l) => l.page))].sort((a, b) => a - b)) {
        const onPage = body.filter((l) => l.page === page).sort((a, b) => b.y - a.y || a.x - b.x);
        const isCode = (l: PdfLine) => l.x >= o.codeX[0] && l.x < o.codeX[1] && CODE_RE.test(l.text);
        const codes = onPage.filter(isCode);
        // Columna de descripción: segmentos de una misma línea visual unidos en orden de x.
        const rows: { y: number; text: string }[] = [];
        for (const l of onPage.filter((l) => l.x >= o.descriptionX)) {
            const row = rows.find((r) => Math.abs(r.y - l.y) < SAME_LINE);
            if (row) row.text = `${row.text} ${l.text}`;
            else rows.push({ y: l.y, text: l.text });
        }
        for (const c of codes) {
            const [, code, inline] = CODE_RE.exec(c.text)!;
            const parts: string[] = [];
            let lastY = c.y;
            if (inline) parts.push(inline);
            const same = rows.find((r) => Math.abs(r.y - c.y) < SAME_LINE);
            if (same) parts.push(same.text);
            if (parts.length === 0) throw new Error(`página ${page}: el código ${code} no tiene descripción en su línea`);
            for (;;) {
                const next = rows.filter((r) => r.y < lastY - 0.5 && lastY - r.y < NEXT_LINE).sort((a, b) => b.y - a.y)[0];
                if (!next || next.text.startsWith("(")) break;
                if (codes.some((k) => Math.abs(k.y - next.y) < SAME_LINE)) break;
                if (balance(parts.join(" ")) <= 0 && next.text.endsWith(")") && !next.text.includes("(")) break;
                parts.push(next.text);
                lastY = next.y;
            }
            entries.push({ code, description: parts.join(" ").replace(/\s+/g, " ").trim(), reference: null });
        }
    }
    return entries;
}

/** Punto de entrada de `cli.ts import-pdf-table`. */
export function importPdfTableMain(argv: string[]): number {
    const a = parseArgs(argv);
    const req = (k: string) => required(a, k);
    const [from, to] = req("code-x").split(":").map(Number);
    const entries = readPdfTable(parsePdfLines(readFileSync(req("lines"), "utf8")), {
        codeX: [from, to],
        descriptionX: Number(req("description-x")),
        until: a.until ?? null,
    });
    const file = buildCatalogFile(readFileSync(req("pdf")), entries, manifestArgsFrom(a, req("pdf")));
    console.log(`${entries.length} entradas leídas de ${req("lines")}`);
    return writeImported(file, req("out"));
}
