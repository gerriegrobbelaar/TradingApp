import type { HTMLAttributes } from "react";

export type ChipTone = "neutral" | "ok" | "warn" | "gold" | "strong";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
}

export function Chip({ tone = "neutral", className, ...rest }: ChipProps) {
  const cls = ["chip", tone === "neutral" ? "" : tone, className ?? ""].filter(Boolean).join(" ");
  return <span className={cls} {...rest} />;
}
