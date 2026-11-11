import { describe, expect, it } from "vitest";
import { matchesQuery, normalizeText, queryTerms } from "./search";

describe("search helpers", () => {
  it("normalises case, diacritics and spacing", () => {
    expect(normalizeText("  Café  ÉLÉGANT ")).toBe("cafe elegant");
    expect(normalizeText("Straße Ørsted Łódź Æon Đorđe")).toBe("strasse orsted lodz aeon dorde");
    expect(queryTerms("   ")).toEqual([]);
    expect(queryTerms("Van  Dijk")).toEqual(["van", "dijk"]);
  });

  it("matches words in any field, case and diacritics insensitive", () => {
    expect(matchesQuery("", ["x"])).toBe(true);
    expect(matchesQuery("jose", ["José Álvarez BV", null])).toBe(true);
    expect(matchesQuery("ÁLVAREZ jose", [undefined, "José Álvarez BV"])).toBe(true);
    expect(matchesQuery("2026001", ["2026001", "Acme"])).toBe(true);
    expect(matchesQuery("2026001 acme", ["2026001", "Acme"])).toBe(true);
    expect(matchesQuery("2026001 zzz", ["2026001", "Acme"])).toBe(false);
    expect(matchesQuery("abc", [null])).toBe(false);
  });
});
