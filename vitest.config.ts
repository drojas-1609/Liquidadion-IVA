import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // En Node, el paquete real "server-only" lanza al importarse. En los
      // tests corremos esas utilidades directamente, así que lo reemplazamos
      // por un stub vacío. El guardado real ocurre en `next build`.
      "server-only": fileURLToPath(new URL("./tests/_stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
