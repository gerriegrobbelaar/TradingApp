import { defineConfig } from "vitest/config";

/**
 * Browser checks of the reporting screens (not part of `pnpm test`): screenshots at 360 and 1280
 * in both themes, and the print stylesheet through Playwright's page.pdf().
 *
 *   pnpm --filter @camelthorn/web build
 *   pnpm --filter @camelthorn/web exec vitest run --config scripts/vitest.screens.config.ts
 *
 * Needs Playwright (PLAYWRIGHT_PATH, default "playwright"), Chrome (CHROME_PATH, default
 * /usr/bin/google-chrome) and poppler's pdfinfo / pdftoppm / pdftotext.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "scripts/k3b-screens.e2e.ts",
      "scripts/r2-screens.e2e.ts",
      "scripts/r3b-screens.e2e.ts",
      "scripts/q2-screens.e2e.ts",
      "scripts/f3-screens.e2e.ts",
    ],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
