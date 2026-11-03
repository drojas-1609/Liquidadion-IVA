/** Predicado de build de producción, sin dependencias de servidor (lo importa next.config.ts). */
export const ARCA_PROD_BUILD_FLAG = "ARCA_PROD_BUILD_ELIGIBLE";
export const ARCA_PROD_BRANCH = "main";
export function arcaProdBuildEligible(env: Readonly<Record<string, string | undefined>>): boolean {
    return env.NETLIFY === "true" && env.CONTEXT === "production" && env.HEAD === ARCA_PROD_BRANCH;
}
