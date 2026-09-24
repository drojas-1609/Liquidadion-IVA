import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTrustedOrigin } from "@/lib/auth/origin";

const ENV_KEYS = [
  "CONTEXT",
  "NODE_ENV",
  "URL",
  "DEPLOY_PRIME_URL",
  "DEPLOY_URL",
  "AUTH_PRODUCTION_ORIGIN",
] as const;

const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined>;

function setEnv(patch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
}

function req(headers: Record<string, string>) {
  return { headers: new Headers(headers) };
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = env[k];
  for (const k of ENV_KEYS) delete env[k];
  env.NODE_ENV = "test";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("getTrustedOrigin — desarrollo local", () => {
  it("sin request => localhost:3000", () => {
    expect(getTrustedOrigin()).toBe("http://localhost:3000");
  });

  it("Host malicioso en la request se ignora en dev", () => {
    expect(getTrustedOrigin(req({ host: "evil.com" }))).toBe("http://localhost:3000");
    expect(
      getTrustedOrigin(req({ "x-forwarded-host": "evil.com", host: "localhost:3000" })),
    ).toBe("http://localhost:3000");
  });

  it("acepta localhost con cualquier puerto", () => {
    expect(
      getTrustedOrigin(req({ host: "localhost:4000", "x-forwarded-proto": "http" })),
    ).toBe("http://localhost:4000");
  });
});

describe("getTrustedOrigin — deploy preview", () => {
  beforeEach(() => setEnv({ CONTEXT: "deploy-preview" }));

  it("usa DEPLOY_PRIME_URL válido del propio sitio", () => {
    setEnv({ DEPLOY_PRIME_URL: "https://deploy-preview-42--liquidadoriva.netlify.app" });
    expect(getTrustedOrigin(req({ host: "evil.com" }))).toBe(
      "https://deploy-preview-42--liquidadoriva.netlify.app",
    );
  });

  it("rechaza DEPLOY_PRIME_URL de otro dominio => origen de producción", () => {
    setEnv({ DEPLOY_PRIME_URL: "https://evil.com" });
    expect(getTrustedOrigin()).toBe("https://liquidadoriva.netlify.app");
  });

  it("rechaza sufijo falsificado (host que NO termina exactamente en el sitio)", () => {
    setEnv({ DEPLOY_PRIME_URL: "https://x--liquidadoriva.netlify.app.evil.com" });
    expect(getTrustedOrigin()).toBe("https://liquidadoriva.netlify.app");
  });

  it("rechaza DEPLOY_PRIME_URL no-HTTPS", () => {
    setEnv({ DEPLOY_PRIME_URL: "http://deploy-preview-1--liquidadoriva.netlify.app" });
    expect(getTrustedOrigin()).toBe("https://liquidadoriva.netlify.app");
  });
});

describe("getTrustedOrigin — producción", () => {
  it("prioriza AUTH_PRODUCTION_ORIGIN validado", () => {
    setEnv({ CONTEXT: "production", AUTH_PRODUCTION_ORIGIN: "https://app.derocompany.com.ar" });
    expect(getTrustedOrigin(req({ "x-forwarded-host": "evil.com" }))).toBe(
      "https://app.derocompany.com.ar",
    );
  });

  it("si no hay origin explícito, usa la URL de Netlify (HTTPS)", () => {
    setEnv({ CONTEXT: "production", URL: "https://liquidadoriva.netlify.app" });
    expect(getTrustedOrigin()).toBe("https://liquidadoriva.netlify.app");
  });

  it("descarta AUTH_PRODUCTION_ORIGIN con credenciales embebidas", () => {
    setEnv({ CONTEXT: "production", AUTH_PRODUCTION_ORIGIN: "https://u:p@app.derocompany.com.ar" });
    expect(getTrustedOrigin()).toBe("https://liquidadoriva.netlify.app");
  });

  it("descarta URL de Netlify no-HTTPS", () => {
    setEnv({ CONTEXT: "production", URL: "http://liquidadoriva.netlify.app" });
    expect(getTrustedOrigin()).toBe("https://liquidadoriva.netlify.app");
  });
});

describe("getTrustedOrigin — fallback a la request con allow-list estricta", () => {
  beforeEach(() => setEnv({ NODE_ENV: "production", CONTEXT: "runtime" }));

  it("acepta un host de preview del propio sitio", () => {
    expect(
      getTrustedOrigin(req({ host: "deploy-preview-9--liquidadoriva.netlify.app" })),
    ).toBe("https://deploy-preview-9--liquidadoriva.netlify.app");
  });

  it("acepta el dominio de producción declarado", () => {
    setEnv({ AUTH_PRODUCTION_ORIGIN: "https://app.derocompany.com.ar" });
    expect(getTrustedOrigin(req({ host: "app.derocompany.com.ar" }))).toBe(
      "https://app.derocompany.com.ar",
    );
  });

  it("rechaza Host arbitrario => origen de producción", () => {
    expect(getTrustedOrigin(req({ host: "evil.com" }))).toBe("https://liquidadoriva.netlify.app");
  });

  it("rechaza sufijo falsificado del dominio del sitio", () => {
    expect(
      getTrustedOrigin(req({ host: "liquidadoriva.netlify.app.evil.com" })),
    ).toBe("https://liquidadoriva.netlify.app");
  });

  it("rechaza X-Forwarded-Host con lista de hosts (toma el primero y lo valida)", () => {
    expect(
      getTrustedOrigin(
        req({ "x-forwarded-host": "evil.com, liquidadoriva.netlify.app", host: "liquidadoriva.netlify.app" }),
      ),
    ).toBe("https://liquidadoriva.netlify.app");
  });
});
