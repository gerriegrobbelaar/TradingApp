/** Text matching for invoice number / relation name search (case and diacritics insensitive). */

/** Lower case, diacritics removed, runs of white space collapsed to one space, trimmed. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ß/g, "ss")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/đ/gi, "d")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Words of a query after normalising; empty for a blank query. */
export function queryTerms(query: string): string[] {
  const n = normalizeText(query);
  return n === "" ? [] : n.split(" ");
}

/**
 * True when every word of `query` appears (as a substring) in at least one of the fields. A blank
 * query matches everything. Null fields are ignored.
 */
export function matchesQuery(
  query: string,
  fields: readonly (string | null | undefined)[],
): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const haystacks = fields.filter((f): f is string => typeof f === "string").map(normalizeText);
  return terms.every((t) => haystacks.some((h) => h.includes(t)));
}

/**
 * The stored search text of a row (`open_items.search_text`, migration 0009): every field
 * normalised on its own and joined with a line feed. Query terms never contain white space, so a
 * term matches the joined text exactly when it matches one field (the same rule as
 * `matchesQuery`). Null and empty fields are left out.
 */
export function searchText(fields: readonly (string | number | null | undefined)[]): string {
  return fields
    .filter((f): f is string | number => f !== null && f !== undefined)
    .map((f) => normalizeText(String(f)))
    .filter((f) => f !== "")
    .join("\n");
}

/** Most distinct words a search may have (each is one bound LIKE parameter). */
export const MAX_QUERY_TERMS = 8;

/**
 * SQL LIKE patterns (`... LIKE ? ESCAPE '\'`) for a query against `searchText`: one
 * `%term%` per distinct word, with `\`, `%` and `_` escaped. Throws RangeError beyond
 * MAX_QUERY_TERMS words.
 */
export function likePatterns(query: string): string[] {
  const terms = [...new Set(queryTerms(query))];
  if (terms.length > MAX_QUERY_TERMS) throw new RangeError("too many search terms");
  return terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}
