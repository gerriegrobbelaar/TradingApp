import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseColor, parseThemes, type TokenMap } from "./contrast";

const css = readFileSync(join(__dirname, "tokens.css"), "utf8");
const themes = parseThemes(css);

/** [foreground token, background token, base token the background sits on] */
const PAIRS: [string, string, string][] = [
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

function ratio(t: TokenMap, fg: string, bg: string, base: string): number {
  return contrastRatio(
    parseColor(t[fg] as string),
    parseColor(t[bg] as string),
    parseColor(t[base] as string),
  );
}

describe("token contrast >= 4.5:1", () => {
  // Dark is the :root default; light is data-theme and the auto media query.
  const sets: [string, TokenMap][] = [
    ["dark", themes.dark],
    ["light", { ...themes.dark, ...themes.light }],
    ["auto (system light)", { ...themes.dark, ...themes.auto }],
  ];
  for (const [name, tokens] of sets) {
    for (const [fg, bg, base] of PAIRS) {
      it(`${name}: ${fg} on ${bg}`, () => {
        expect(ratio(tokens, fg, bg, base)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("auto light tokens equal the explicit light tokens", () => {
    expect(themes.auto).toEqual(themes.light);
  });
});
