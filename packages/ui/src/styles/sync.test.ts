import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");

/** Drop comments and blank lines so only rules are compared. */
function rules(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n");
}

describe("package styles stay in sync with docs/design/app.css", () => {
  it("tokens.css + components.css equal the design stylesheet", () => {
    const design = rules(read("..", "..", "..", "..", "docs", "design", "app.css"));
    const ported = rules(read("tokens.css") + "\n" + read("components.css"));
    expect(ported).toBe(design);
  });

  it("honours prefers-reduced-motion", () => {
    expect(read("components.css")).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\{\s*\.app \*\{animation:none !important;transition:none !important\}/,
    );
  });
});
