import type { AgeingBucket, AgeingReportRow } from "@camelthorn/core";
import type { ChipTone } from "@camelthorn/ui";

export const BUCKET_LABEL: Record<AgeingBucket, string> = {
  not_due: "Not due",
  d1_30: "1–30 days",
  d31_60: "31–60 days",
  d61_90: "61–90 days",
  d90_plus: "90+ days",
  no_due_date: "No due date",
};

export const BUCKET_TONE: Record<AgeingBucket, ChipTone> = {
  not_due: "neutral",
  d1_30: "gold",
  d31_60: "warn",
  d61_90: "warn",
  d90_plus: "warn",
  no_due_date: "neutral",
};

export type AgeingSort = "outstanding" | "name";

/** Ageing rows in the order the screen (and the Excel file) shows them. Never mutates. */
export function sortAgeingRows(
  rows: readonly AgeingReportRow[],
  mode: AgeingSort,
): AgeingReportRow[] {
  const copy = [...rows];
  const name = (r: AgeingReportRow) => r.relation.name ?? "";
  if (mode === "name") {
    copy.sort((a, b) => {
      // Unknown relations last.
      if ((a.relation.name === null) !== (b.relation.name === null)) {
        return a.relation.name === null ? 1 : -1;
      }
      return name(a).localeCompare(name(b), "en") || b.totalMinor - a.totalMinor;
    });
  } else {
    copy.sort((a, b) => b.totalMinor - a.totalMinor || name(a).localeCompare(name(b), "en"));
  }
  return copy;
}
