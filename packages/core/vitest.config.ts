import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Heavy oracle suites run alongside other packages in `pnpm test`; a timeout is a runaway guard.
    testTimeout: 30_000,
    // Hooks get the same guard (a hanging beforeAll would otherwise wait for the default only).
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
