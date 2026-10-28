#!/usr/bin/env node
/**
 * Control POSTERIOR al build: verifica qué contiene el directorio `.next` respecto
 * de los fixtures sintéticos de prueba visual (lib/preview-fixtures).
 *
 *   node scripts/preview-fixtures/verify-build.mjs --expect absent [--dir .next]   # producción
 *   node scripts/preview-fixtures/verify-build.mjs --expect present [--dir .next]  # Deploy Preview habilitado
 *
 * «absent»: ninguna de las huellas aparece en NINGÚN archivo (código, source
 * maps, trazas), salvo el caché de TypeScript (.tsbuildinfo, no se sirve).
 * «present»: las huellas aparecen sólo en archivos del servidor, nunca en
 * `.next/static` (lo que se envía al navegador).
 * Buscar textos es un control complementario: la exclusión se decide en
 * next.config.ts (alias al stub) y se reevalúa en el servidor (loader.ts).
 * No imprime contenido de archivos: sólo rutas relativas y conteos.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const expect = get("expect");
const dir = get("dir", ".next");
if (expect !== "absent" && expect !== "present") {
    console.error("uso: --expect absent|present [--dir .next]");
    process.exit(64);
}
const MARKERS = ["SINTETICO-NO-OFICIAL-PRUEBA-VISUAL", "prueba-sintetica-naes", "prueba-sintetica-reglas-901", "pruebaSinOtroTratamiento", "lib/preview-fixtures/data.ts"];

function* walk(d) {
    for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = lstatSync(p);
        // Los enlaces simbólicos (p. ej. node_modules trazados) no se siguen: apuntan fuera del build.
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) yield* walk(p);
        else if (!name.endsWith(".tsbuildinfo")) yield p;
    }
}
const hits = new Map(MARKERS.map((m) => [m, []]));
for (const f of walk(dir)) {
    const text = readFileSync(f, "latin1");
    for (const m of MARKERS) if (text.includes(m)) hits.get(m).push(relative(dir, f));
}
const all = [...new Set([...hits.values()].flat())];
const inStatic = all.filter((f) => f.startsWith("static"));
let ok;
if (expect === "absent") {
    ok = all.length === 0;
    console.log(ok ? `OK: ninguna huella de fixtures en ${dir}` : `FALLA: huellas de fixtures en ${all.length} archivo(s): ${all.join(", ")}`);
} else {
    ok = MARKERS.slice(0, 4).every((m) => hits.get(m).length > 0) && inStatic.length === 0;
    console.log(ok ? `OK: fixtures sólo en el servidor (${all.length} archivo(s)); nada en static/` : `FALLA: ${inStatic.length ? `huellas en static/: ${inStatic.join(", ")}` : "faltan huellas esperadas"}`);
}
process.exit(ok ? 0 : 1);
