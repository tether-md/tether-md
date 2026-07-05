import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Unit tests run against kernel source, not its built dist.
      "@tether-md/kernel": fileURLToPath(new URL("../kernel/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // Only the pure logic is unit-tested here; extension.ts needs the VSCode host.
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
