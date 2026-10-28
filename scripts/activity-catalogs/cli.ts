/**
 * Entrada de línea de comandos de los catálogos (vite-node no conserva la ruta
 * del script en process.argv, así que los módulos no pueden detectar si son el
 * principal; se importan sin efectos y este archivo despacha).
 *
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- import --source ... (ver import.ts)
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- review|approve|add-check --file ... (revisión por niveles; ver review.ts)
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- import-pdf-table --pdf ... --lines ... (ver pdf-table.ts)
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- crosscheck --file ... --text ... (ver crosscheck-pdf.ts)
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- compare-arca-web --file ... --html ... (ver compare-arca-web.ts)
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- arba-naiibb --alicuotaria ... --otros ... (ver arba-naiibb.ts)
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- caba-2026 ... (reglas de alícuotas; ver scripts/iibb-rates/caba-2026.ts)
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- arba-2026 ... (reglas de alícuotas; ver scripts/iibb-rates/arba-2026.ts)
 */
import { arbaMain } from "./arba-naiibb";
import { compareArcaWebMain } from "./compare-arca-web";
import { crosscheckMain } from "./crosscheck-pdf";
import { importMain } from "./import";
import { importPdfTableMain } from "./pdf-table";
import { arba2026Main } from "../iibb-rates/arba-2026";
import { cabaMain } from "../iibb-rates/caba-2026";
import { addCheckMain, approveMain, reviewMain } from "./review";

const [command, ...rest] = process.argv.slice(2).filter((x, i) => !(i === 0 && x === "--"));
const commands: Record<string, (argv: string[]) => number> = {
    import: importMain,
    "import-pdf-table": importPdfTableMain,
    review: reviewMain,
    approve: approveMain,
    "add-check": addCheckMain,
    crosscheck: crosscheckMain,
    "compare-arca-web": compareArcaWebMain,
    "arba-naiibb": arbaMain,
    "caba-2026": cabaMain,
    "arba-2026": arba2026Main,
};

try {
    const run = command ? commands[command] : undefined;
    if (!run) throw new Error(`comando desconocido "${command ?? ""}": usar ${Object.keys(commands).join(", ")}`);
    process.exitCode = run(rest);
} catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exitCode = 1;
}
