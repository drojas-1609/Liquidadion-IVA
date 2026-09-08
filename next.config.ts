import type { NextConfig } from "next";

import { SECURITY_HEADERS } from "./lib/security-headers";

/**
 * Cabeceras de seguridad base (Tarea 3A). El set vive en
 * `lib/security-headers.ts` y lo comparten `next.config.ts` y `proxy.ts`.
 */
const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
