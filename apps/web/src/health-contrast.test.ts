/**
 * Contrast of the colour pairs the Data health and Today screens add (D8c), computed from the real token values
 * like bank-contrast.test.ts. health.css only uses tokens that are already checked for text on
 * cards (--ink, --muted, --accent-text on --fill and --hover); the scan below fails if a new colour
 * is introduced without a pair being added here.
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
const css = readFileSync(join(__dirname, "health.css"), "utf8");
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

describe("health.css only uses checked colour tokens", () => {
  it("every colour is one of the tokens below", () => {
    const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
    const allowed = new Set([
      "--ink",
      "--muted",
      "--fill",
      "--hover",
      "--control-line",
      "--accent-text",
    ]);
    expect([...used].filter((u) => !allowed.has(u as string))).toEqual([]);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|opacity/);
  });
});

describe("tiles, queue items and the action bar keep their contrast", () => {
  // A card is --fill; the selected candidate card replaces it with --hover (never stacked).
  const BACKS = [["--fill"], ["--hover"]];
  for (const [name, t] of SETS) {
    for (const surface of SURFACES) {
      for (const back of BACKS) {
        for (const fg of ["--ink", "--muted", "--accent-text"]) {
          it(`${name}: ${fg} on ${surface} > ${back.join(" > ")}`, () => {
            expect(contrastRatio(tok(t, fg), stack(t, [surface, ...back]))).toBeGreaterThanOrEqual(
              4.5,
            );
          });
        }
      }
      it(`${name}: selected borders (--accent-text) are 3:1 on ${surface} > --hover and > --fill`, () => {
        expect(
          contrastRatio(tok(t, "--accent-text"), stack(t, [surface, "--hover"])),
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(tok(t, "--accent-text"), stack(t, [surface, "--fill"])),
        ).toBeGreaterThanOrEqual(3);
      });
      it(`${name}: tile and item borders (--control-line) are 3:1 on ${surface}`, () => {
        expect(contrastRatio(tok(t, "--control-line"), stack(t, [surface]))).toBeGreaterThanOrEqual(
          3,
        );
      });
    }
  }
});

describe("review D8c: severity chips and the focus ring inside queue items and tiles", () => {
  // Queue items have no fill (health.css): their chips (packages/ui components.css) sit on the bare
  // card. A fill under them drops the dark-theme chips below 4.5:1 (measured 3.6 to 4.1), so this
  // test also guards against a fill coming back.
  const CHIPS: [string, string][] = [
    ["--warn-text", "--warn-soft"], // critical
    ["--gold", "--gold-soft"], // warning
    ["--muted", "--fill"], // info / neutral
  ];
  it("queue items carry no background fill", () => {
    const item = /\.app \.today-item(\.sel)? \{[^}]*\}/g;
    for (const block of css.match(item) ?? []) expect(block).not.toMatch(/background/);
  });
  for (const [name, t] of SETS) {
    for (const surface of SURFACES) {
      for (const [fg, bg] of CHIPS) {
        it(`${name}: chip ${fg} on ${bg} inside a queue item on ${surface}`, () => {
          expect(contrastRatio(tok(t, fg), stack(t, [surface, bg]))).toBeGreaterThanOrEqual(4.5);
        });
      }
      it(`${name}: focus ring and selection (--accent-text) are 3:1 on ${surface}, > --fill, > --hover`, () => {
        for (const back of [[], ["--fill"], ["--hover"]]) {
          expect(
            contrastRatio(tok(t, "--accent-text"), stack(t, [surface, ...back])),
          ).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }
});
