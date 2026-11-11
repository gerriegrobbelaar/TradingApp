import { describe, expect, it } from "vitest";
import { likePatterns, matchesQuery, normalizeText, queryTerms, searchText } from "./search";

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

describe("stored search text", () => {
  // The SQL side is `search_text LIKE pattern ESCAPE '\'`; this mirrors it for the property check.
  const like = (text: string, pattern: string): boolean => {
    const body = pattern.slice(1, -1).replace(/\\([\\%_])/g, "$1");
    return text.includes(body);
  };

  it("normalises each field and joins them with a line feed", () => {
    expect(searchText(["INV-1", 42, null, undefined, "  ", "Café  Élan"])).toBe(
      "inv-1\n42\ncafe elan",
    );
    expect(searchText([null, null])).toBe("");
  });

  it("escapes LIKE wildcards and de-duplicates terms", () => {
    expect(likePatterns("")).toEqual([]);
    expect(likePatterns("100% a_b c\\d")).toEqual(["%100\\%%", "%a\\_b%", "%c\\\\d%"]);
    expect(likePatterns("acme ACME Ácme")).toEqual(["%acme%"]);
    expect(() => likePatterns("a b c d e f g h")).not.toThrow();
    expect(() => likePatterns("a b c d e f g h i")).toThrow(RangeError);
  });

  it("agrees with matchesQuery on every term (no match across field borders)", () => {
    const fields = ["2026001", "Müller & Zonen", "Order 77"];
    const text = searchText(fields);
    for (const q of [
      "muller",
      "2026001 zonen",
      "order 77",
      "1 m",
      "zonen order",
      "77 zzz",
      "0 &",
    ]) {
      const viaLike = likePatterns(q).every((p) => like(text, p));
      expect([q, viaLike]).toEqual([q, matchesQuery(q, fields)]);
    }
    // "zonen\norder" is never one term, so a query cannot match across two fields.
    expect(likePatterns("zonen order")).toHaveLength(2);
  });
});
