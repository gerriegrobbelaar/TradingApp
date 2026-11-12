/// <reference types="vite/client" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  over,
  parseColor,
  parseThemes,
  type TokenMap,
} from "@camelthorn/ui/contrast";

/**
 * Phase 8 review V2: the Notifications screen does no floating-point arithmetic, never touches an
 * IBAN, never uses storage, never reads or sends an API key value, has no exclamation mark, and adds
 * no colours of its own (it reuses classes whose contrast is checked below).
 */
const src = (
  import.meta.glob("./pages/Notifications.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>
)["./pages/Notifications.tsx"] as string;
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const code = stripComments(src);

describe("Notifications source", () => {
  it("reads the file", () => {
    expect(code.length).toBeGreaterThan(1000);
  });
  it("does no float arithmetic (the one Number() is a whole number from digits only)", () => {
    for (const re of [/\bparseFloat\b/, /\bparseInt\b/, /\.\s*toFixed\b/, /\bIntl\s*\./]) {
      expect(code).not.toMatch(re);
    }
    // The only Math is Math.ceil of the whole-second countdown (integer milliseconds).
    expect(code.match(/\bMath\s*\.\s*\w+/g)).toEqual(["Math.ceil"]);
    expect((code.match(/\bNumber\s*\(/g) ?? []).length).toBe(1);
    expect(code).toMatch(/\/\^\\d\{1,3\}\$\/\.test/);
  });
  it("never names an IBAN and never uses storage or cookies", () => {
    expect(code).not.toMatch(/iban/i);
    expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
  });
  it("only ever uses the key's presence flag", () => {
    const uses = [...code.matchAll(/\.(\w*[kK]ey\w*)\b/g)]
      .map((m) => m[1])
      .filter((u) => u !== "keys");
    expect(uses.every((u) => u === "apiKeyPresent")).toBe(true);
    expect(code).not.toMatch(/type=["']password["']|EMAIL_API_KEY|Authorization/);
  });
  it("has no exclamation mark in a string literal", () => {
    const hit = [...code.matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].some((m) =>
      /!/.test(m[1] ?? m[2] ?? ""),
    );
    expect(hit).toBe(false);
  });
  it("adds no inline colours or styles", () => {
    expect(code).not.toMatch(/style=|#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});

describe("colours the Notifications screen reuses keep their contrast", () => {
  const themes = parseThemes(
    readFileSync(join(__dirname, "../../../packages/ui/src/styles/tokens.css"), "utf8"),
  );
  const SETS: [string, TokenMap][] = [
    ["dark", themes.dark],
    ["light", { ...themes.dark, ...themes.light }],
  ];
  const tok = (t: TokenMap, n: string) => {
    const v = t[n];
    if (v === undefined) throw new Error(`Missing token ${n}`);
    return parseColor(v);
  };
  const stack = (t: TokenMap, layers: string[]) => {
    let c = tok(t, "--bg");
    for (const l of layers) c = over(tok(t, l), c);
    return c;
  };
  for (const [name, t] of SETS) {
    for (const surface of ["--glass-1", "--glass-2", "--sheet"]) {
      it(`${name}: hints (.cap, --muted) and errors (.cap.bad, --warn-text) on ${surface}`, () => {
        for (const fg of ["--muted", "--warn-text", "--ink"]) {
          expect(contrastRatio(tok(t, fg), stack(t, [surface]))).toBeGreaterThanOrEqual(4.5);
        }
      });
      it(`${name}: warning notice (--warn-text on --warn-soft) on ${surface}`, () => {
        expect(
          contrastRatio(tok(t, "--warn-text"), stack(t, [surface, "--warn-soft"])),
        ).toBeGreaterThanOrEqual(4.5);
      });
      it(`${name}: plain notice (--ink on --sunken) on ${surface}`, () => {
        expect(
          contrastRatio(tok(t, "--ink"), stack(t, [surface, "--sunken"])),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
