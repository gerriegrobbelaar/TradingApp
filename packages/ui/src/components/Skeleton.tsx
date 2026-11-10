import type { CSSProperties } from "react";

export interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
}

/** Decorative loading placeholder; pair it with a live region that announces loading. */
export function Skeleton({ width = "100%", height = 16 }: SkeletonProps) {
  return <span className="sk" aria-hidden="true" style={{ width, height }} />;
}
