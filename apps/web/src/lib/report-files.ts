/** File names for report exports (also used for the print dialog's suggested PDF name). */

export type ReportSlug =
  "balance-sheet" | "profit-loss" | "creditors-ageing" | "receivables-ageing";

/** "Alpha B.V. (Test)" -> "alpha-b-v-test": lower case ASCII, digits and single hyphens. */
export function slugify(value: string): string {
  const s = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "administration";
}

/** `camelthorn-<report>-<administration-slug>-<asOf>`: the file name without its extension. */
export function reportFileBase(slug: ReportSlug, administration: string, asOfPart: string): string {
  const as = asOfPart.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "report";
  return `camelthorn-${slug}-${slugify(administration)}-${as}`;
}

/** `camelthorn-<report>-<administration-slug>-<asOf>.xlsx` */
export function exportFileName(
  slug: ReportSlug,
  administration: string,
  asOfPart: string,
  extension = "xlsx",
): string {
  return `${reportFileBase(slug, administration, asOfPart)}.${extension}`;
}
