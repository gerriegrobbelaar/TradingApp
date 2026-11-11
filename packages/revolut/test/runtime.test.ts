import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The package runs inside Cloudflare Workers: src may only use web platform APIs. The tsconfig
// includes Node types for the tests, so this guard catches what the type checker cannot.
describe("Workers runtime", () => {
  it("src uses no Node-only APIs", () => {
    const dir = join(import.meta.dirname, "..", "src");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const code = readFileSync(join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(
        /\bBuffer\b|\bprocess\.|\brequire\(|from "node:|from "(?:crypto|fs|path|buffer|util)"|\bsetImmediate\b|__dirname/,
      );
    }
  });
});
