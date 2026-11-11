/**
 * Contrast of the colour pairs the FX presentation adds (F3), computed from the real tokens like
 * bank-contrast.test.ts. Text: 4.5:1. The chart line and the freshness chips are non-text or chip
 * pairs (line 3:1). fx.css must take every colour from a token.
 */
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

const tokensCss = readFileSync(
  join(__dirname, "../../../packages/ui/src/styles/tokens.css"),
  "utf8",
);
const fxCss = readFileSync(join(__dirname, "fx.css"), "utf8");
const themes = parseThemes(tokensCss);
const SETS: [string, TokenMap][] = [
  ["dark", themes.dark],
  ["light", { ...themes.dark, ...themes.light }],
];
const SURFACES = ["--glass-1", "--glass-2", "--sheet"];

function tok(t: TokenMap, name: string) {
  const v = t[name];
  if (v === undefined) throw new Error(`Missing token ${name}`);
  return parseColor(v);
}
function stack(t: TokenMap, layers: string[]) {
  let c = tok(t, "--bg");
  for (const l of layers) c = over(tok(t, l), c);
  return c;
}

describe("FX text, chips and chart line keep their contrast", () => {
  for (const [name, t] of SETS) {
    for (const surface of SURFACES) {
      it(`${name}: secondary FX lines (--muted) and the missing-rate line on ${surface}`, () => {
        expect(contrastRatio(tok(t, "--muted"), stack(t, [surface]))).toBeGreaterThanOrEqual(4.5);
      });
      it(`${name}: the primary FX numbers (--ink) on ${surface}`, () => {
        expect(contrastRatio(tok(t, "--ink"), stack(t, [surface]))).toBeGreaterThanOrEqual(4.5);
      });
      it(`${name}: the chart line (--accent-text) on ${surface} is at least 3:1`, () => {
        expect(contrastRatio(tok(t, "--accent-text"), stack(t, [surface]))).toBeGreaterThanOrEqual(
          3,
        );
      });
      it(`${name}: axis labels (cap, --muted) on ${surface}`, () => {
        expect(contrastRatio(tok(t, "--muted"), stack(t, [surface]))).toBeGreaterThanOrEqual(4.5);
      });
      it(`${name}: the amber stale chip (--warn-text on --warn-soft) on ${surface}`, () => {
        expect(
          contrastRatio(tok(t, "--warn-text"), stack(t, [surface, "--warn-soft"])),
        ).toBeGreaterThanOrEqual(4.5);
      });
      it(`${name}: the up to date chip (--accent-text on --accent-soft) on ${surface}`, () => {
        expect(
          contrastRatio(tok(t, "--accent-text"), stack(t, [surface, "--accent-soft"])),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("fx.css uses tokens only: no hex or rgb colours", () => {
    const code = fxCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/#[0-9a-fA-F]{3,8}\b/.test(code)).toBe(false);
    expect(/\brgba?\(|\bhsla?\(/.test(code)).toBe(false);
  });

  it("fx.css has no animation, so reduced motion has nothing to switch off", () => {
    expect(/animation|transition/.test(fxCss)).toBe(false);
  });
});
