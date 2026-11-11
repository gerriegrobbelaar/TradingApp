/**
 * Contrast of the colour pairs the read-only screens add (review K3a), computed from the real
 * token values like packages/ui/src/styles/contrast.test.ts. Translucent layers are composited
 * in the order they stack: --bg, then the surface (card gradient ends or sheet), then the row
 * state (--hover, also used for the selected row), then the chip fill, then the text.
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
const appCss = readFileSync(join(__dirname, "app.css"), "utf8");
const themes = parseThemes(tokensCss);
const SETS: [string, TokenMap][] = [
  ["dark", themes.dark],
  ["light", { ...themes.dark, ...themes.light }],
];

function tok(t: TokenMap, name: string) {
  const v = t[name];
  if (v === undefined) throw new Error(`Missing token ${name}`);
  return parseColor(v);
}

/** Composite the layers bottom-up, starting on --bg. */
function stack(t: TokenMap, layers: string[]) {
  let c = tok(t, "--bg");
  for (const l of layers) c = over(tok(t, l), c);
  return c;
}

const SURFACES = ["--glass-1", "--glass-2", "--sheet"];

// Text in table rows and drill-down rows: the neutral chip uses --ink there (app.css), the other
// tones keep their colours.
const ROW_TEXT: [string, string[]][] = [
  ["--ink", []],
  ["--muted", []],
  ["--accent-text", []],
  ["--ink", ["--fill"]],
  ["--ink", ["--fill-2"]],
  ["--accent-text", ["--accent-soft"]],
  ["--warn-text", ["--warn-soft"]],
  ["--gold", ["--gold-soft"]],
];

describe("table and drill-down rows (hovered or selected) keep 4.5:1 text", () => {
  for (const [name, t] of SETS) {
    for (const surface of SURFACES) {
      for (const row of [[], ["--hover"]]) {
        for (const [fg, fill] of ROW_TEXT) {
          const where = [surface, ...row, ...fill].join(" > ");
          it(`${name}: ${fg} on ${where}`, () => {
            const bg = stack(t, [surface, ...row, ...fill]);
            expect(contrastRatio(tok(t, fg), bg)).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
    }
  }
});

describe("non-text indicators keep 3:1", () => {
  for (const [name, t] of SETS) {
    for (const surface of SURFACES) {
      it(`${name}: selected-row bar (--accent-text) on ${surface} > --hover`, () => {
        const bg = stack(t, [surface, "--hover"]);
        expect(contrastRatio(tok(t, "--accent-text"), bg)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe("the rules these checks assume are in app.css", () => {
  const flat = appCss.replace(/\s+/g, " ");
  it("selected rows use --hover plus an --accent-text bar, not --accent-soft", () => {
    expect(flat).toContain(".app .dt-table tbody tr.sel { background: var(--hover); }");
    expect(flat).toMatch(
      /\.app \.dt-table tbody tr\.sel > td:first-child \{ box-shadow: inset 3px 0 0 var\(--accent-text\); \}/,
    );
  });
  it("neutral chips in rows use --ink", () => {
    expect(flat).toContain(
      ".app .dt-table .chip:not(.ok):not(.warn):not(.gold), .app .drill-list .chip:not(.ok):not(.warn):not(.gold) { color: var(--ink); }",
    );
  });
});
