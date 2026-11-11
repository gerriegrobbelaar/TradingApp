import type { AgeingBucket } from "@camelthorn/core";
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
