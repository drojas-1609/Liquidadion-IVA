import "server-only";
import { integrityProblems } from "./checksum";
import { validateCatalogFile } from "./validate";
import { previewFixtures } from "../preview-fixtures/loader";
import type { CatalogFile } from "./types";
import claeRgAfip3537_2013 from "@/data/activity-catalogs/clae-rg-afip-3537-2013.json";
import naesRgCa19_2025 from "@/data/activity-catalogs/naes-rg-ca-19-2025.json";
import arbaNaiibb18 from "@/data/activity-catalogs/arba-naiibb18-2026-10-27.json";

/**
 * Registro de versiones de catálogos incluidas en la aplicación.
 *
 * Cada versión se agrega a mano (import explícito, revisable en el PR) después
 * de importarla con `scripts/activity-catalogs/cli.ts import`. Sólo las
 * versiones con `review.status = "REVISADO"` se ofrecen en el buscador y se
 * aceptan como origen en la ficha; el resto queda registrado pero no publicado.
 *
 * Estado actual: NAES (RG CA 19/2025), CLAE (RG AFIP 3537/2013) y NAIIB-18 de ARBA importados y
 * cotejados con sus fuentes, PENDIENTES de la revisión humana (no se ofrecen
 * todavía). Ver
 * docs/catalogos-actividades/README.md, «Cobertura».
 */
// El JSON se tipa con strings amplios; la forma real se valida en `checked`.
const CATALOG_FILES: readonly CatalogFile[] = [naesRgCa19_2025, claeRgAfip3537_2013, arbaNaiibb18] as unknown as CatalogFile[];

/** Valida estructura e integridad al cargar: un archivo inválido nunca se publica. */
function checked(files: readonly CatalogFile[]): CatalogFile[] {
    return files.filter((f) => {
        const problems = [...validateCatalogFile(f), ...integrityProblems(f)];
        if (problems.length > 0) {
            console.error(`[activity-catalog] ${f.manifest?.id ?? "?"} descartado: ${problems.slice(0, 5).join("; ")}`);
            return false;
        }
        return true;
    });
}

let cache: CatalogFile[] | null = null;

/**
 * Catálogos oficiales registrados (validados) y, SÓLO en un Deploy Preview con
 * DEV y las barreras habilitadas, el catálogo sintético de prueba
 * (lib/preview-fixtures). La barrera se reevalúa en cada llamada.
 */
export function activityCatalogs(): CatalogFile[] {
    cache ??= checked(CATALOG_FILES);
    const fx = previewFixtures();
    return fx ? [...cache, ...checked([fx.PREVIEW_CATALOG])] : cache;
}
