import { describe, it, expect } from "vitest";
import { SECURITY_HEADERS, applySecurityHeaders } from "@/lib/security-headers";

const EXPECTED: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
};

describe("lib/security-headers — fuente única", () => {
  it("contiene exactamente los seis encabezados con los valores aprobados", () => {
    expect(SECURITY_HEADERS).toHaveLength(6);
    expect(Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value]))).toEqual(EXPECTED);
  });

  it("CSP es SÓLO frame-ancestors 'none' (sin CSP completa)", () => {
    const csp = SECURITY_HEADERS.find((h) => h.key === "Content-Security-Policy")!.value;
    expect(csp).toBe("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src|default-src|style-src|connect-src/);
  });

  it("HSTS usa max-age=31536000 (coincide con el edge de Netlify)", () => {
    const hsts = SECURITY_HEADERS.find((h) => h.key === "Strict-Transport-Security")!.value;
    expect(hsts).toBe("max-age=31536000; includeSubDomains; preload");
  });

  it("applySecurityHeaders es idempotente y no genera duplicados", () => {
    const h = new Headers();
    applySecurityHeaders(h);
    applySecurityHeaders(h);
    for (const [k, v] of Object.entries(EXPECTED)) expect(h.get(k)).toBe(v);
    // Headers.get colapsa duplicados; comprobamos que no hay comas de append
    expect(h.get("X-Frame-Options")).toBe("DENY");
  });

  it("applySecurityHeaders no toca Cache-Control ni Set-Cookie", () => {
    const h = new Headers();
    h.set("Cache-Control", "no-store, max-age=0");
    h.append("Set-Cookie", "sb-x=1; Path=/; HttpOnly; Secure; SameSite=Lax");
    applySecurityHeaders(h);
    expect(h.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(h.get("Set-Cookie")).toContain("HttpOnly");
    expect(h.get("Set-Cookie")).toContain("SameSite=Lax");
  });
});
