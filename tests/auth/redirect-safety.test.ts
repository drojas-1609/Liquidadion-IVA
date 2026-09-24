import { describe, it, expect } from "vitest";
import { sanitizeNext, buildSafeRedirect } from "@/lib/auth/origin";

describe("sanitizeNext — solo paths internos", () => {
  it("acepta paths internos normales", () => {
    expect(sanitizeNext("/")).toBe("/");
    expect(sanitizeNext("/clients")).toBe("/clients");
    expect(sanitizeNext("/client/abc/period/1?tab=iva")).toBe("/client/abc/period/1?tab=iva");
    expect(sanitizeNext("/a#b")).toBe("/a#b");
  });

  it("rechaza vacío / no-string / ausente", () => {
    expect(sanitizeNext(null)).toBe("/");
    expect(sanitizeNext(undefined)).toBe("/");
    expect(sanitizeNext("")).toBe("/");
    // @ts-expect-error prueba defensiva
    expect(sanitizeNext(123)).toBe("/");
  });

  it("rechaza URLs absolutas y protocol-relative", () => {
    for (const bad of [
      "https://evil.com",
      "http://evil.com/x",
      "//evil.com",
      "//evil.com/path",
      "/\\evil.com",
      "/\\/evil.com",
      "\\\\evil.com",
      "javascript:alert(1)",
      "/javascript:alert(1)",
      " https://evil.com",
      "/%2F%2Fevil.com",
      "/path\twith\ttab",
    ]) {
      expect(sanitizeNext(bad), bad).toBe("/");
    }
  });

  it("rechaza cadenas larguísimas", () => {
    expect(sanitizeNext("/" + "a".repeat(5000))).toBe("/");
  });

  it("respeta el fallback custom", () => {
    expect(sanitizeNext("https://evil.com", "/login")).toBe("/login");
  });
});

describe("buildSafeRedirect — nunca acepta origen del cliente", () => {
  it("combina origen confiable local + next saneado", () => {
    expect(buildSafeRedirect("/clients")).toBe("http://localhost:3000/clients");
    expect(buildSafeRedirect("https://evil.com/x")).toBe("http://localhost:3000/");
  });

  it("aunque la request traiga Host malicioso, el next sigue siendo interno", () => {
    const req = { headers: new Headers({ host: "evil.com" }) };
    const out = buildSafeRedirect("/dashboard", req);
    expect(out.endsWith("/dashboard")).toBe(true);
    expect(out.includes("evil.com")).toBe(false);
  });
});
