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

// ---- reporting screens (review K3b) -------------------------------------------------------------

const reportsCss = readFileSync(join(__dirname, "reports.css"), "utf8");

/** The colour token each ageing bar segment uses, read from reports.css. */
function segmentTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of reportsCss.matchAll(
    /\.seg-([a-z0-9_]+)\s*\{\s*background:\s*var\((--[a-z0-9-]+)\);/g,
  )) {
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

describe("ageing bars (Mix) and their legend keep 3:1 against the bar track in both themes", () => {
  const segs = segmentTokens();
  it("reports.css colours every bucket", () => {
    expect(Object.keys(segs).sort()).toEqual(
      ["d1_30", "d31_60", "d61_90", "d90_plus", "no_due_date", "not_due"].sort(),
    );
    expect(reportsCss.replace(/\s+/g, " ")).toContain("background: var(--fill);");
  });
  for (const [name, t] of SETS) {
    for (const surface of SURFACES) {
      for (const [bucket, token] of Object.entries(segs)) {
        it(`${name}: ${bucket} (${token}) on ${surface} > --fill and on ${surface}`, () => {
          // the bar's track
          expect(
            contrastRatio(tok(t, token), stack(t, [surface, "--fill"])),
          ).toBeGreaterThanOrEqual(3);
          // the legend swatch sits on the card itself
          expect(contrastRatio(tok(t, token), stack(t, [surface]))).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }
});

describe("report tables keep 4.5:1 text", () => {
  for (const [name, t] of SETS) {
    // the pinned first column at phone width is painted with --bg
    for (const fg of ["--ink", "--muted", "--accent-text"]) {
      it(`${name}: ${fg} on the pinned column (--bg)`, () => {
        expect(contrastRatio(tok(t, fg), tok(t, "--bg"))).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const surface of SURFACES) {
      it(`${name}: the 'does not balance' difference row (--warn-text) on ${surface}`, () => {
        expect(contrastRatio(tok(t, "--warn-text"), stack(t, [surface]))).toBeGreaterThanOrEqual(
          4.5,
        );
      });
    }
  }
  it("the rules these checks assume are in reports.css", () => {
    const flat = reportsCss.replace(/\s+/g, " ");
    expect(flat).toMatch(/position: sticky; left: 0; z-index: 1; background: var\(--bg\);/);
    expect(flat).toContain(".totals-row.diff-bad td { color: var(--warn-text); }");
  });
});
