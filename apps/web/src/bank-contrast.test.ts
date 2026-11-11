/**
 * Contrast of the colour pairs the Bank screen adds (R3b), computed from the real token values
 * like contrast.test.ts. Layers are composited bottom-up: --bg, the surface, the row or card state
 * (--fill, or --hover when hovered or selected), then a chip fill.
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
const bankCss = readFileSync(join(__dirname, "bank.css"), "utf8");
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

describe("bank account cards and amounts keep their contrast", () => {
  const CARD_STATES = [["--fill"], ["--hover"]];
  for (const [name, t] of SETS) {
    for (const surface of SURFACES) {
      for (const st of CARD_STATES) {
        for (const fg of ["--ink", "--muted", "--accent-text"]) {
          it(`${name}: ${fg} on ${surface} > ${st.join(" > ")} (card text, inactive card, received amount)`, () => {
            expect(contrastRatio(tok(t, fg), stack(t, [surface, ...st]))).toBeGreaterThanOrEqual(
              4.5,
            );
          });
        }
        it(`${name}: neutral chip (--ink on --fill) on ${surface} > ${st.join(" > ")}`, () => {
          expect(
            contrastRatio(tok(t, "--ink"), stack(t, [surface, ...st, "--fill"])),
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
      it(`${name}: selected card border (--accent-text) on ${surface} > --hover is 3:1`, () => {
        expect(
          contrastRatio(tok(t, "--accent-text"), stack(t, [surface, "--hover"])),
        ).toBeGreaterThanOrEqual(3);
      });
      it(`${name}: card border (--control-line) on ${surface} is 3:1`, () => {
        expect(contrastRatio(tok(t, "--control-line"), stack(t, [surface]))).toBeGreaterThanOrEqual(
          3,
        );
      });
    }
  }

  it("the rules these checks assume are in bank.css", () => {
    const flat = bankCss.replace(/\s+/g, " ");
    expect(flat).toContain(".app .tx-in { color: var(--accent-text); }");
    expect(flat).toContain(".app .tx-out { color: var(--ink); }");
    expect(flat).toContain(
      ".app .acct.off .acct-name, .app .acct.off .acct-bal { color: var(--muted); }",
    );
    expect(flat).toContain(
      ".app .acct .chip:not(.ok):not(.warn):not(.gold) { color: var(--ink); }",
    );
    expect(flat).toContain("background: var(--fill);");
    expect(flat).not.toMatch(/opacity/);
  });
});
