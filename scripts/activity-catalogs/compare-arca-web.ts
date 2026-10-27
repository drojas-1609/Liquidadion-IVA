/**
 * Cotejo de una versión del CLAE contra el «Nomenclador de Actividades
 * Económicas» en línea de ARCA (página oficial guardada como HTML):
 * https://serviciosweb.afip.gob.ar/genericos/nomencladoractividades/index.aspx
 *
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- compare-arca-web \
 *     --file data/activity-catalogs/clae-rg-afip-3537-2013.json --html nomenclador.html
 *
 * La página agrega notas «(incluye …)» a algunas descripciones: una descripción
 * del catálogo coincide si es el comienzo del texto web (sin acentos, signos ni
 * mayúsculas). Informa; no modifica nada. Sale con 3 si hay diferencias.
 */
import { readFileSync } from "node:fs";
import type { CatalogEntry, CatalogFile } from "../../lib/activity-catalog/types";

const decode = (s: string) =>
    s
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&([a-z]+);/gi, (m) => ({ "&lt;": "<", "&gt;": ">", "&aacute;": "á", "&eacute;": "é", "&iacute;": "í", "&oacute;": "ó", "&uacute;": "ú", "&ntilde;": "ñ" })[m] ?? m);

/** Pares código -> descripciones tal como los muestra la página ("011111: " y la línea siguiente). */
export function parseArcaNomenclatorHtml(html: string): Map<string, string[]> {
    const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "\n"));
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const out = new Map<string, string[]>();
    lines.forEach((l, i) => {
        const m = /^(\d{6}):$/.exec(l);
        if (m && lines[i + 1] !== undefined) out.set(m[1], [...(out.get(m[1]) ?? []), lines[i + 1]]);
    });
    return out;
}

const key = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

export interface ArcaWebComparison {
    webCodes: number;
    onlyInCatalog: string[];
    onlyInWeb: string[];
    differences: Array<{ code: string; catalog: string; web: string[] }>;
}

export function compareWithArcaWeb(entries: readonly CatalogEntry[], web: ReadonlyMap<string, string[]>): ArcaWebComparison {
    const codes = new Set(entries.map((e) => e.code));
    return {
        webCodes: web.size,
        onlyInCatalog: [...codes].filter((c) => !web.has(c)).sort(),
        onlyInWeb: [...web.keys()].filter((c) => !codes.has(c)).sort(),
        differences: entries
            .filter((e) => web.has(e.code) && !web.get(e.code)!.some((w) => key(w).startsWith(key(e.description))))
            .map((e) => ({ code: e.code, catalog: e.description, web: web.get(e.code)! })),
    };
}

export function compareArcaWebMain(argv: string[]): number {
    const a = argv.filter((x) => x !== "--");
    const get = (k: string) => (a.indexOf(`--${k}`) >= 0 ? a[a.indexOf(`--${k}`) + 1] : undefined);
    const file = get("file");
    const html = get("html");
    if (!file || !html) throw new Error("uso: --file <clae.json> --html <nomenclador.html>");
    const catalog = JSON.parse(readFileSync(file, "utf8")) as CatalogFile;
    const r = compareWithArcaWeb(catalog.entries, parseArcaNomenclatorHtml(readFileSync(html, "utf8")));
    console.log(`${catalog.manifest.id}: ${catalog.entries.length} entradas; ${r.webCodes} códigos en la página de ARCA`);
    console.log(`- sólo en el catálogo: ${r.onlyInCatalog.length} ${r.onlyInCatalog.join(" ")}`);
    console.log(`- sólo en la página (no actividades del F.883, p. ej. tabla anexa): ${r.onlyInWeb.length} ${r.onlyInWeb.join(" ")}`);
    console.log(`- descripciones distintas: ${r.differences.length}`);
    for (const d of r.differences) console.log(`  ${d.code}: catálogo «${d.catalog}» / web «${d.web.join(" | ")}»`);
    return r.onlyInCatalog.length + r.differences.length === 0 ? 0 : 3;
}
