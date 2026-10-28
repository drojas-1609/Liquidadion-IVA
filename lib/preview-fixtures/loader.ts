import "server-only";
import { BUILD_FLAG_VAR, evaluateFixtureGate } from "./gate";
// Con la barrera de build cerrada, next.config.ts resuelve este import a data-disabled.ts.
import { previewFixtureData, type PreviewFixtureData } from "@/lib/preview-fixtures/data";

/**
 * Fixtures sintéticos, sólo si las DOS barreras lo permiten:
 *
 *  1. Build: `process.env.CATALOG_FIXTURES_BUILD` es una constante que
 *     next.config.ts inlinea ("1" o "0"). Con "0", `previewFixtureData()` no
 *     arma nada y su contenido se elimina del bundle (ver data.ts).
 *  2. Runtime: en CADA llamada se reevalúan activación, vencimiento y destino
 *     DEV con el entorno real del servidor. Si algo falla, no se sirven.
 */
export function previewFixtures(now: Date = new Date()): PreviewFixtureData | null {
    // Expresión literal (no `process.env[...]`): es la que Next reemplaza en el build.
    const builtWithFixtures = process.env.CATALOG_FIXTURES_BUILD;
    if (builtWithFixtures !== "1") return null;
    const gate = evaluateFixtureGate({ ...process.env, [BUILD_FLAG_VAR]: builtWithFixtures }, "runtime", now);
    return gate.enabled ? previewFixtureData() : null;
}
