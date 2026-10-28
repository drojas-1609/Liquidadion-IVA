import type { NextConfig } from "next";
import { ARCA_HOMO_BUILD_FLAG, arcaHomoBuildEligible, arcaHomoRuntimeEligible } from "./lib/arca-padron/preview-gate";
import path from "node:path";
import {mkdirSync,writeFileSync,rmSync} from "node:fs";

import { SECURITY_HEADERS } from "./lib/security-headers";
import { BUILD_FLAG_VAR, evaluateFixtureGate } from "./lib/preview-fixtures/gate";

/**
 * Catálogos sintéticos de prueba visual (lib/preview-fixtures): se EMPAQUETAN
 * sólo si el build es un Deploy Preview con activación explícita y conexión a
 * DEV. En cualquier otro caso la constante vale "0" y el código que los importa
 * se elimina del bundle. Además, el servidor reevalúa la barrera en cada uso.
 * El log sólo informa nombres de variables y causas, nunca valores.
 */
const fixtureGate = evaluateFixtureGate(process.env, "build", new Date());
const arcaBuildEligible = arcaHomoBuildEligible(process.env);
// Constancia pública sin credenciales: sólo este build puede observar los secretos.
const proofPath = path.join(process.cwd(), "public/.well-known/arca-preview-destination.json");
rmSync(proofPath, {force:true});
if (arcaBuildEligible && /^[a-f0-9]{40}$/.test(process.env.COMMIT_REF ?? "")) {
 const now=Date.now();
 const dev=arcaHomoRuntimeEligible({...process.env, ARCA_HOMO_PREVIEW:"1", ARCA_PADRON_ENV:"homologacion", ARCA_HOMO_HASTA:new Date(now+86400000).toISOString()}, "1", now);
 mkdirSync(path.dirname(proofPath), {recursive:true});
 writeFileSync(proofPath, JSON.stringify({version:1,commit:process.env.COMMIT_REF,branch:process.env.HEAD,dev:dev===true}));
}

if (arcaBuildEligible) console.info("[arca-homo] Build elegible; runtime exige activación, caducidad y DEV.");
if (fixtureGate.enabled) console.warn("[catalogos-sinteticos] HABILITADOS en este build (Deploy Preview con DEV)");
else if (process.env.CATALOGOS_SINTETICOS !== undefined) console.warn(`[catalogos-sinteticos] deshabilitados: ${fixtureGate.reasons.join("; ")}`);

/**
 * Cabeceras de seguridad base (Tarea 3A). El set vive en
 * `lib/security-headers.ts` y lo comparten `next.config.ts` y `proxy.ts`.
 */
// Con la barrera cerrada, el módulo de datos se reemplaza por un stub vacío:
// los fixtures no entran al grafo de módulos (ni al código ni a los source maps).
const FIXTURE_DATA_MODULE = "@/lib/preview-fixtures/data";
const fixtureDataTarget = fixtureGate.enabled ? "./lib/preview-fixtures/data.ts" : "./lib/preview-fixtures/data-disabled.ts";

const nextConfig: NextConfig = {
  env: { [BUILD_FLAG_VAR]: fixtureGate.enabled ? "1" : "0", [ARCA_HOMO_BUILD_FLAG]: arcaBuildEligible ? "1" : "0" },
  turbopack: { resolveAlias: { [FIXTURE_DATA_MODULE]: fixtureDataTarget } },
  webpack(config) {
    config.resolve ??= {};
    config.resolve.alias = { ...(config.resolve.alias ?? {}), [FIXTURE_DATA_MODULE]: path.resolve(process.cwd(), fixtureDataTarget) };
    return config;
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
