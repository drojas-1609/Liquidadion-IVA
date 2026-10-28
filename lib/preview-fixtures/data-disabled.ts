/**
 * Sustituto de `data.ts` en todo build en que la barrera de build está cerrada
 * (producción, branch deploys, builds locales): next.config.ts redirige el
 * import de `@/lib/preview-fixtures/data` a este archivo, así que los datos
 * sintéticos no entran al grafo de módulos (ni al código ni a los source maps).
 */
import type { PreviewFixtureData } from "./data";

export type { PreviewFixtureData };

export function previewFixtureData(): PreviewFixtureData | null {
    return null;
}
