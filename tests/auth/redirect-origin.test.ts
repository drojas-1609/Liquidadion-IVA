/**
 * Política de host compartida por logout y callback (`getSafeRedirectOrigin`).
 * Devuelve un ORIGEN (`scheme://host[:port]`); el path lo agrega el llamador.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSafeRedirectOrigin, buildSafeRedirect } from "@/lib/auth/origin";

const env = process.env as Record<string, string | undefined>;
const ENV_KEYS = ["NODE_ENV", "CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"];
let saved: Record<string, string | undefined>;

function reqXfh(xfHost: string, proto = "https") {
  return {
    headers: new Headers({
      "x-forwarded-host": xfHost,
      "x-forwarded-proto": proto,
      host: "internal.netlify",
    }),
  };
}
function reqHost(host: string, extra: Record<string, string> = {}) {
  return { headers: new Headers({ host, ...extra }) };
}

const SITE_ORIGIN = "https://derocompanygestion.netlify.app";

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = env[k];
  for (const k of ["CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"]) delete env[k];
  env.NODE_ENV = "production"; // simula runtime desplegado sin vars de build
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("getSafeRedirectOrigin — entorno válido preservado", () => {
  it("Deploy Preview -> mismo preview", () => {
    expect(getSafeRedirectOrigin(reqXfh("deploy-preview-3--derocompanygestion.netlify.app"))).toBe(
      "https://deploy-preview-3--derocompanygestion.netlify.app",
    );
  });

  it("no hardcodea el número: acepta cualquier deploy-preview-<n>", () => {
    for (const n of [1, 7, 42, 99999]) {
      expect(getSafeRedirectOrigin(reqXfh(`deploy-preview-${n}--derocompanygestion.netlify.app`))).toBe(
        `https://deploy-preview-${n}--derocompanygestion.netlify.app`,
      );
    }
  });

  it("Producción (host del sitio) -> producción", () => {
    expect(getSafeRedirectOrigin(reqXfh("derocompanygestion.netlify.app"))).toBe(SITE_ORIGIN);
  });

  it("Producción con AUTH_PRODUCTION_ORIGIN -> ese dominio", () => {
    env.AUTH_PRODUCTION_ORIGIN = "https://app.derocompany.com.ar";
    expect(getSafeRedirectOrigin(reqXfh("app.derocompany.com.ar"))).toBe(
      "https://app.derocompany.com.ar",
    );
  });

  it("localhost sólo en desarrollo", () => {
    env.NODE_ENV = "development";
    expect(getSafeRedirectOrigin(reqHost("localhost:3000"))).toBe("http://localhost:3000");
    expect(getSafeRedirectOrigin(reqHost("localhost:5173", { "x-forwarded-proto": "http" }))).toBe(
      "http://localhost:5173",
    );
  });
});

describe("getSafeRedirectOrigin — rechazos (seguridad)", () => {
  it("host reenviado controlado por el usuario -> NO se usa", () => {
    for (const bad of ["evil.com", "attacker.example", "phish.liquidadoriva.com"]) {
      expect(getSafeRedirectOrigin(reqXfh(bad)), bad).toBe(SITE_ORIGIN);
    }
  });

  it("hostname parecido / sufijo o prefijo extra / puerto inesperado -> rechazado", () => {
    for (const bad of [
      "deploy-preview-3--derocompanygestion.netlify.app.evil.com",
      "deploy-preview-3--derocompanygestion.netlify.app.attacker.io",
      "evildeploy-preview-3--derocompanygestion.netlify.app",
      "deploy-preview-x--derocompanygestion.netlify.app",
      "deploy-preview---derocompanygestion.netlify.app",
      "deploy-preview-3--liquidadoriva-netlify.app",
      "derocompanygestion.netlify.app.evil.com",
      "xderocompanygestion.netlify.app",
      "deploy-preview-3--derocompanygestion.netlify.app:8080",
      "derocompanygestion.netlify.app:8443",
    ]) {
      expect(getSafeRedirectOrigin(reqXfh(bad)), bad).toBe(SITE_ORIGIN);
    }
  });

  it("protocolo inválido o downgrade a http en host de Netlify -> rechazado", () => {
    expect(getSafeRedirectOrigin(reqXfh("deploy-preview-3--derocompanygestion.netlify.app", "ftp"))).toBe(
      SITE_ORIGIN,
    );
    expect(
      getSafeRedirectOrigin(reqXfh("deploy-preview-3--derocompanygestion.netlify.app", "http")),
    ).toBe(SITE_ORIGIN);
  });

  it("localhost NO se acepta en producción", () => {
    expect(getSafeRedirectOrigin(reqXfh("localhost:3000", "http"))).toBe(SITE_ORIGIN);
  });

  it("sin cabeceras utilizables -> fallback seguro (nunca abierto)", () => {
    expect(getSafeRedirectOrigin({ headers: new Headers() })).toBe(SITE_ORIGIN);
    expect(getSafeRedirectOrigin()).toBe(SITE_ORIGIN);
  });
});

describe("buildSafeRedirect usa getSafeRedirectOrigin + sanitizeNext", () => {
  it("preview + next interno -> mismo preview + path", () => {
    expect(
      buildSafeRedirect("/clients", reqXfh("deploy-preview-3--derocompanygestion.netlify.app")),
    ).toBe("https://deploy-preview-3--derocompanygestion.netlify.app/clients");
  });

  it("next externo/malicioso -> se descarta, path interno", () => {
    const out = buildSafeRedirect(
      "https://evil.com/x",
      reqXfh("deploy-preview-3--derocompanygestion.netlify.app"),
    );
    expect(out).toBe("https://deploy-preview-3--derocompanygestion.netlify.app/");
  });

  it("host malicioso + next válido -> origen seguro + path", () => {
    const out = buildSafeRedirect("/update-password", reqXfh("evil.com"));
    expect(out).toBe("https://derocompanygestion.netlify.app/update-password");
  });
});
