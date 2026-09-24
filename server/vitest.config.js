import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    alias: {
      "@google/genai/server": "node_modules/@google/genai/dist/node/index.mjs",
    },
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
