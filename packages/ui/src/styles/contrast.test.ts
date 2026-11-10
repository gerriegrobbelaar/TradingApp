import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, over, parseColor, parseThemes, type TokenMap } from "./contrast";

const css = readFileSync(join(__dirname, "tokens.css"), "utf8");
const themes = parseThemes(css);

// Dark is the :root default; light is data-theme and the auto media query.
const SETS: [string, TokenMap][] = [
  ["dark", themes.dark],
  ["light", { ...themes.dark, ...themes.light }],
  ["auto (system light)", { ...themes.dark, ...themes.auto }],
];

/** [foreground token, background token, base token the background sits on] */
const TEXT_PAIRS: [string, string, string][] = [
  ["--ink", "--bg", "--bg"],
  ["--muted", "--bg", "--bg"],
  ["--subtle", "--bg", "--bg"],
  ["--accent-text", "--bg", "--bg"],
  ["--warn-text", "--bg", "--bg"],
  ["--accent-ink", "--accent", "--bg"],
  ["--seg-on-ink", "--seg-on", "--bg"],
  ["--accent-text", "--accent-soft", "--bg"],
  ["--warn-text", "--warn-soft", "--bg"],
  ["--gold", "--gold-soft", "--bg"],
  ["--ink", "--fill-2", "--bg"],
  ["--muted", "--fill", "--bg"],
  ["--muted", "--sunken", "--bg"],
];

/** Text on the glass surfaces that hold most content: sheets/toasts/menus and cards. */
const SURFACES = ["--sheet", "--glass-1"] as const;
const SURFACE_TEXT = ["--ink", "--muted", "--accent-text", "--warn-text", "--gold"] as const;

function tok(t: TokenMap, name: string) {
  const v = t[name];
  if (v === undefined) throw new Error(`Missing token ${name}`);
  return parseColor(v);
}

function ratio(t: TokenMap, fg: string, bg: string, base: string): number {
  return contrastRatio(tok(t, fg), tok(t, bg), tok(t, base));
}

/** Ratio of fg on a surface that itself sits on --bg. */
function onSurface(t: TokenMap, fg: string, surface: string): number {
  const solid = over(tok(t, surface), tok(t, "--bg"));
  return contrastRatio(tok(t, fg), solid);
}

describe("text contrast >= 4.5:1", () => {
  for (const [name, tokens] of SETS) {
    for (const [fg, bg, base] of TEXT_PAIRS) {
      it(`${name}: ${fg} on ${bg}`, () => {
        expect(ratio(tokens, fg, bg, base)).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const surface of SURFACES) {
      for (const fg of SURFACE_TEXT) {
        it(`${name}: ${fg} on ${surface} surface`, () => {
          expect(onSurface(tokens, fg, surface)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it(`${name}: --subtle on --sheet surface`, () => {
      expect(onSurface(tokens, "--subtle", "--sheet")).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("auto light tokens equal the explicit light tokens", () => {
    expect(themes.auto).toEqual(themes.light);
  });
});

describe("non-text contrast >= 3:1 (WCAG 1.4.11)", () => {
  // Focus ring is `outline: 2px solid var(--accent-text)` on whatever the control sits on.
  const FOCUS_SURFACES = ["--bg", "--fill", "--fill-2", "--sunken", "--sheet", "--glass-1"];
  for (const [name, tokens] of SETS) {
    for (const surface of FOCUS_SURFACES) {
      it(`${name}: focus ring (--accent-text) on ${surface}`, () => {
        expect(onSurface(tokens, "--accent-text", surface)).toBeGreaterThanOrEqual(3);
      });
    }
    // --accent fills the checked switch track and the primary button.
    for (const surface of ["--bg", "--sheet", "--glass-1"]) {
      it(`${name}: --accent fill on ${surface}`, () => {
        expect(onSurface(tokens, "--accent", surface)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  // Interactive control borders (.input, .btn, .seg, .search, .switch, .check) use --control-line.
  const CONTROL_SURFACES = ["--bg", "--sheet", "--glass-1"];
  for (const [name, tokens] of SETS) {
    for (const surface of CONTROL_SURFACES) {
      it(`${name}: --control-line on ${surface}`, () => {
        expect(onSurface(tokens, "--control-line", surface)).toBeGreaterThanOrEqual(3);
      });
    }
    it(`${name}: switch knob on off-state track`, () => {
      const track = over(tok(tokens, "--track-off"), tok(tokens, "--bg"));
      expect(contrastRatio(tok(tokens, "--knob"), track)).toBeGreaterThanOrEqual(3);
    });
  }
  // Decorative --line (table rules, dividers) is intentionally low contrast.
});
