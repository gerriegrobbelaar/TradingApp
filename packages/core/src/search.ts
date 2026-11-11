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
