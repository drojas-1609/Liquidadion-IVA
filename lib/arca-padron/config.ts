import "server-only";
import {createHash} from "node:crypto";
import {createCmsSigner} from "./cms";
import {parseCacheKey} from "./ticket-store";
import {PADRON_SERVICE} from "./padron";
import { normalizeCuit } from "../cuit";
import type { ArcaEnvironment } from "./padron";
import type { CmsSigner } from "./wsaa";

/**
 * Configuración de la consulta de CUIT en ARCA (sólo servidor).
 *
 * Variables de entorno (NUNCA en el repositorio, el navegador ni los logs):
 *   ARCA_PADRON_ENABLED             "true" para habilitar (opt-in explícito)
 *   ARCA_PADRON_ENV                 "homologacion" | "produccion"
 *   ARCA_PADRON_CUIT_REPRESENTADA   CUIT del estudio que firma las consultas
 *   ARCA_WSAA_CERT_PEM              certificado X.509 emitido por ARCA (PEM)
 *   ARCA_WSAA_KEY_PEM               clave privada del certificado (PEM)
 *
 * Firmante CMS node-forge con SHA-256 y certificado RSA; tickets cifrados en
 * almacén PostgreSQL compartido. La habilitación requiere configuración completa.
 *
 * El estado nunca expone valores: sólo qué falta (nombres de variables) para
 * la documentación del servidor; la API responde un mensaje genérico.
 */

export type ArcaConfigStatus =
    | {
          configured: true;
          environment: ArcaEnvironment;
          /** 11 dígitos. */
          cuitRepresentada: string;
          signer: CmsSigner;
          ticketScope?: string;
          cacheKey?: Buffer;
      }
    | {
          configured: false;
          reason: "DISABLED" | "MISSING_SETTINGS" | "INVALID_SETTINGS" | "SIGNER_UNAVAILABLE";
          missing: string[];
      };

export const ARCA_ENV_VARS = [
    "ARCA_PADRON_ENABLED",
    "ARCA_PADRON_ENV",
    "ARCA_PADRON_CUIT_REPRESENTADA",
    "ARCA_WSAA_CERT_PEM",
    "ARCA_WSAA_KEY_PEM",
    "ARCA_WSAA_CACHE_KEY",
] as const;

/**
 * Firmante CMS del TRA; null ante certificado o clave inválidos.
 */
export const resolveCmsSigner = createCmsSigner;

export function readArcaConfig(
    env: Readonly<Record<string, string | undefined>> = process.env,
    signerFactory: (certPem: string, keyPem: string, password?: string) => CmsSigner | null = resolveCmsSigner,
): ArcaConfigStatus {
    if (env.ARCA_PADRON_ENABLED !== "true") return { configured: false, reason: "DISABLED", missing: [] };
    const missing = ARCA_ENV_VARS.filter((k) => !env[k] || env[k]!.trim() === "");
    if (missing.length > 0) return { configured: false, reason: "MISSING_SETTINGS", missing };

    const environment = env.ARCA_PADRON_ENV!.trim();
    const cuit = normalizeCuit(env.ARCA_PADRON_CUIT_REPRESENTADA);
    const pemOk = (v: string) => /-----BEGIN [A-Z ]+-----/.test(v);
    const invalid: string[] = [];
    if (environment !== "homologacion" && environment !== "produccion") invalid.push("ARCA_PADRON_ENV");
    if (!cuit.ok) invalid.push("ARCA_PADRON_CUIT_REPRESENTADA");
    if (!pemOk(env.ARCA_WSAA_CERT_PEM!)) invalid.push("ARCA_WSAA_CERT_PEM");
    if (!pemOk(env.ARCA_WSAA_KEY_PEM!)) invalid.push("ARCA_WSAA_KEY_PEM");
    if (invalid.length > 0 || !cuit.ok) return { configured: false, reason: "INVALID_SETTINGS", missing: invalid };

    const cacheKey = parseCacheKey(env.ARCA_WSAA_CACHE_KEY);
    if (!cacheKey) return {configured:false,reason:"INVALID_SETTINGS",missing:["ARCA_WSAA_CACHE_KEY"]};
    const signer = signerFactory(env.ARCA_WSAA_CERT_PEM!, env.ARCA_WSAA_KEY_PEM!, env.ARCA_WSAA_KEY_PASSWORD);
    if (!signer) return { configured: false, reason: "SIGNER_UNAVAILABLE", missing: [] };

    return {
        configured: true,
        environment: environment as ArcaEnvironment,
        cuitRepresentada: cuit.value.replace(/-/g, ""),
        signer,
        cacheKey,
        ticketScope: createHash("sha256").update([environment,cuit.value,PADRON_SERVICE,createHash("sha256").update(env.ARCA_WSAA_CERT_PEM!.replace(/\s/g,"" )).digest("hex")].join("|")).digest("hex"),
    };
}
