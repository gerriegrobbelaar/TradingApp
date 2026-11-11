/**
 * Defensive masking of server text before it reaches the page (review M7d). The worker already
 * masks IBANs in every matching answer; the UI masks again so a regression on the server (or a new
 * field) cannot put a full IBAN in the DOM, a title, an aria label or a URL. Uses core's maskIbans
 * (country-aware, over-masks rather than under-masks).
 */
import { maskIbans } from "@camelthorn/core";

export function maskIbanLike(text: string): string;
export function maskIbanLike(text: string | null | undefined): string | null;
export function maskIbanLike(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  return maskIbans(text);
}

/**
 * Every string inside a JSON answer, IBAN-masked (objects and arrays are copied, numbers, booleans
 * and null are kept). Applied to every matching and booking answer at the API boundary.
 */
export function maskDeep<T>(value: T): T {
  return walk(value, 0) as T;
}

function walk(v: unknown, depth: number): unknown {
  if (typeof v === "string") return maskIbans(v);
  if (v === null || typeof v !== "object" || depth > 20) return v;
  if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
  return out;
}
