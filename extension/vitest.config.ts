import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@study-flow/client": fileURLToPath(new URL("../packages/client/src/index.ts", import.meta.url)),
      "@study-flow/shared": fileURLToPath(new URL("../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    css: { modules: { classNameStrategy: "non-scoped" } },
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      include: ["src/**/*.{ts,tsx,js,jsx}"],
      exclude: ["**/*.test.*", "**/*.d.ts"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
