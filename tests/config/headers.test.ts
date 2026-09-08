import { describe, it, expect } from "vitest";
import nextConfig from "@/next.config";

describe("next.config — cabeceras de seguridad", () => {
  it("expone async headers()", () => {
    expect(typeof nextConfig.headers).toBe("function");
  });

  it("aplica el set base a todas las rutas", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");

    const byKey = Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]));
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
    expect(byKey["Permissions-Policy"]).toContain("geolocation=()");
  });
});
