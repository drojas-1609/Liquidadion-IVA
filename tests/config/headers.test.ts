import { describe, it, expect } from "vitest";
import nextConfig from "@/next.config";
import { SECURITY_HEADERS } from "@/lib/security-headers";

describe("next.config — cabeceras de seguridad", () => {
  it("expone async headers()", () => {
    expect(typeof nextConfig.headers).toBe("function");
  });

  it("aplica exactamente el set compartido (sin divergir de lib/security-headers)", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");
    // mismo contenido, misma fuente
    expect(rules[0].headers).toEqual(SECURITY_HEADERS);

    const byKey = Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]));
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains; preload");
    expect(byKey["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), browsing-topics=()",
    );
  });
});
