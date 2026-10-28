/**
 * Catálogo y reglas SINTÉTICOS para la prueba visual en un Deploy Preview con
 * Supabase DEV. NO son datos oficiales: códigos 999xxx inexistentes, textos
 * «[PRUEBA]» y la marca SINTETICO-NO-OFICIAL-PRUEBA-VISUAL (que el control
 * posterior al build busca en el bundle de producción).
 *
 * Se usa sólo desde `loader.ts`, que además exige la barrera de runtime.
 *
 * Los datos se construyen dentro de `makeData()`, que sólo se invoca si la
 * constante del build `process.env.CATALOG_FIXTURES_BUILD` vale "1". En un build
 * de producción esa condición es falsa en compilación: la rama y `makeData()`
 * (con todos los textos y códigos) se eliminan del bundle. El control
 * posterior al build lo verifica.
 */
import { entriesSha256 } from "../activity-catalog/checksum";
import type { ReviewInfo } from "../activity-catalog/review";
import type { CatalogEntry, CatalogFile } from "../activity-catalog/types";
import type { RateRuleSet } from "../iibb-rates/types";

function makeData() {
    const FIXTURE_MARKER = "SINTETICO-NO-OFICIAL-PRUEBA-VISUAL";

    const level = {
        status: "CONFORME" as const,
        reviewedBy: "[PRUEBA] sintético: no es una revisión real",
        reviewedAt: "2026-10-27",
        notes: FIXTURE_MARKER,
        checks: [],
    };
    const review = (levels: Array<"technical" | "validity" | "interpretation">): ReviewInfo => ({
        status: "REVISADO",
        reviewedBy: "[PRUEBA] sintético: no es una aprobación real",
        reviewedAt: "2026-10-27",
        notes: FIXTURE_MARKER,
        levels: Object.fromEntries(levels.map((l) => [l, level])),
    });

    const entries: CatalogEntry[] = [
        {
            code: "999001",
            description: "[PRUEBA] Servicios sintéticos de consultoría (no oficial)",
            reference: null,
        },
        {
            code: "999002",
            description: "[PRUEBA] Venta sintética al por menor (no oficial)",
            reference: null,
        },
        {
            code: "999003",
            description: "[PRUEBA] Actividad sintética dada de baja (no oficial)",
            reference: null,
            validFrom: "2018-01-01",
            validTo: "2025-12-31",
        },
    ];

    const PREVIEW_CATALOG: CatalogFile = {
        manifest: {
            id: "prueba-sintetica-naes",
            nomenclator: "NAES",
            jurisdiction: null,
            name: `[PRUEBA] Catálogo sintético (no oficial) ${FIXTURE_MARKER}`,
            organism: "[PRUEBA] sin organismo",
            norm: "[PRUEBA] sin norma",
            sourceUrl: "https://example.invalid/prueba-sintetica",
            sourceFile: "prueba-sintetica.json",
            publishedAt: "2026-10-27",
            consultedAt: "2026-10-27",
            version: "[PRUEBA] sintética",
            validFrom: "2018-01-01",
            validTo: null,
            sourceSha256: "0".repeat(64),
            entriesSha256: entriesSha256(entries),
            entryCount: entries.length,
            supersedes: null,
            review: review(["technical", "validity"]),
        },
        entries,
    };

    const PREVIEW_RULES: RateRuleSet = {
        manifest: {
            id: "prueba-sintetica-reglas-901",
            jurisdiction: "901",
            nomenclator: "NAES",
            catalogIds: [PREVIEW_CATALOG.manifest.id],
            organism: "[PRUEBA] sin organismo",
            norm: `[PRUEBA] Norma sintética (no oficial) ${FIXTURE_MARKER}`,
            sourceUrl: "https://example.invalid/prueba-sintetica-norma",
            publishedAt: "2026-10-27",
            consultedAt: "2026-10-27",
            version: "[PRUEBA] sintética",
            validFrom: "2026-01-01",
            validTo: "2026-12-31",
            sourceSha256: "0".repeat(64),
            review: review(["technical", "validity", "interpretation"]),
        },
        rules: [
            // Sin condiciones: permite ver «Confirmar sugerencia de la norma».
            {
                id: "sin-condiciones",
                activityCodes: ["999001"],
                registrations: [],
                validFrom: null,
                validTo: null,
                treatment: "RATE",
                rate: "1.23",
                conditions: [],
                legalReference: "[PRUEBA] art. sintético 1",
            },
            // Condicionadas: permiten ver hechos declarados y «Registrar como decisión del estudio».
            {
                id: "tramo-bajo",
                activityCodes: ["999002"],
                registrations: [],
                validFrom: null,
                validTo: null,
                treatment: "RATE",
                rate: "2.5",
                conditions: [
                    {
                        kind: "PRIOR_YEAR_GROSS_INCOME",
                        minExclusive: null,
                        maxInclusive: "1000000",
                        description: "[PRUEBA] Ingresos del año anterior hasta $1.000.000",
                    },
                    {
                        kind: "DECLARED_FACT",
                        factKey: "pruebaSinOtroTratamiento",
                        expected: true,
                        description: "[PRUEBA] Hecho sintético declarado por el estudio",
                    },
                ],
                legalReference: "[PRUEBA] art. sintético 2",
            },
            {
                id: "tramo-alto",
                activityCodes: ["999002"],
                registrations: [],
                validFrom: null,
                validTo: null,
                treatment: "RATE",
                rate: "4.5",
                conditions: [
                    {
                        kind: "PRIOR_YEAR_GROSS_INCOME",
                        minExclusive: "1000000",
                        maxInclusive: null,
                        description: "[PRUEBA] Ingresos del año anterior mayores a $1.000.000",
                    },
                    {
                        kind: "DECLARED_FACT",
                        factKey: "pruebaSinOtroTratamiento",
                        expected: true,
                        description: "[PRUEBA] Hecho sintético declarado por el estudio",
                    },
                ],
                legalReference: "[PRUEBA] art. sintético 3",
            },
        ],
    };
    return { PREVIEW_CATALOG, PREVIEW_RULES, FIXTURE_MARKER };
}

export type PreviewFixtureData = ReturnType<typeof makeData>;

let memo: PreviewFixtureData | null = null;

/** Datos sintéticos, o null si el build no los empaquetó. No evalúa la barrera de runtime (eso es loader.ts). */
export function previewFixtureData(): PreviewFixtureData | null {
    // Expresión literal: next.config.ts la reemplaza por "0" o "1" en el build.
    if (process.env.CATALOG_FIXTURES_BUILD === "1") {
        memo ??= makeData();
        return memo;
    }
    return null;
}
