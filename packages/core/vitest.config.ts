import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // TEMPORARY (task H2): schedule.ts is a stub until task H1 merges; remove this exclusion then.
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/schedule.ts"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
