/** Shared helpers of the DQ rules (pure). */
import { formatMinor, currencyScale } from "../money";
import { maskIbans } from "../redact";
import { sha256Hex } from "../sha256";
import type {
  DqDetails,
  DqFixTarget,
  DqIssue,
  DqRuleConfig,
  DqRuleDef,
  DqRuleOutcome,
  DqThreshold,
} from "./types";

/** At most this many issues per rule and run; beyond it the outcome is `truncated`. */
export const MAX_ISSUES_PER_RULE = 500;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
const MAX_LABEL = 80;
const MAX_MESSAGE = 240;
const MAX_KEY = 100;

/** Text for people: control and bidi characters out, whitespace collapsed, IBANs masked, capped. */
export function cleanText(raw: string | null | undefined, max = MAX_LABEL): string {
  if (raw === null || raw === undefined) return "";
  const noControl = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const masked = maskIbans(noControl);
  const chars = Array.from(masked);
  return chars.length <= max ? masked : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * A subject key that is safe to store and compare: plain characters only. Anything else (unicode
 * names, long text) is replaced by a hash of the whole key, so equal keys still give equal
 * fingerprints and different keys cannot collide on a truncation.
 */
export function subjectKey(parts: readonly (string | number)[]): string {
  const raw = parts.map(String).join("|");
  if (raw.length <= MAX_KEY && /^[A-Za-z0-9._:|@-]+$/.test(raw)) return raw;
  return `h-${sha256Hex(raw).slice(0, 32)}`;
}

/** Whole days between an instant and `nowMs`; null for an unparseable or future-only date. */
export function ageMs(nowMs: number, iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : nowMs - t;
}

export const wholeDays = (ms: number): number => Math.floor(ms / DAY_MS);

/** "EUR 12.05" at the currency's scale; "EUR ?" for an amount that is not a safe integer. */
export function amountText(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) return `${currency} ?`;
  return `${currency} ${formatMinor(minor, currencyScale(currency))}`;
}

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export interface IssueParts {
  subject: string;
  message: string;
  amountMinor?: number | null;
  currency?: string | null;
  details?: DqDetails;
}

/** The fingerprint `makeIssue` gives a subject key (for `unjudged` lists). */
export const fingerprintOf = (ruleId: string, key: readonly (string | number)[]): string =>
  `${ruleId}:${subjectKey(key)}`;

export function makeIssue(
  rule: Pick<DqRuleDef, "id" | "fix">,
  config: Pick<DqRuleConfig, "severity">,
  key: readonly (string | number)[],
  p: IssueParts,
  fix?: DqFixTarget,
): DqIssue {
  const amount =
    p.amountMinor !== undefined && p.amountMinor !== null && Number.isSafeInteger(p.amountMinor)
      ? p.amountMinor
      : null;
  return {
    ruleId: rule.id,
    fingerprint: fingerprintOf(rule.id, key),
    severity: config.severity,
    subject: cleanText(p.subject),
    message: cleanText(p.message, MAX_MESSAGE),
    fix: fix ?? rule.fix,
    amountMinor: amount,
    currency: amount === null ? null : (p.currency ?? null),
    details: sanitizeDetails(p.details ?? {}),
  };
}

function sanitizeDetails(d: DqDetails): DqDetails {
  const out: DqDetails = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] = typeof v === "string" ? cleanText(v, 60) : v;
  }
  return out;
}

/** Orders issues by fingerprint, drops repeated fingerprints (the first wins) and applies the cap. */
export function finish(
  issues: DqIssue[],
  checked: number,
  unjudged: readonly string[] = [],
): DqRuleOutcome {
  const seen = new Set<string>();
  const unique: DqIssue[] = [];
  for (const i of issues) {
    if (seen.has(i.fingerprint)) continue;
    seen.add(i.fingerprint);
    unique.push(i);
  }
  const kept = unique.slice(0, MAX_ISSUES_PER_RULE);
  return {
    status: unique.length > 0 ? "issues" : "ok",
    issues: kept,
    checked,
    truncated: unique.length > kept.length,
    total: unique.length,
    ...(unjudged.length > 0 ? { unjudged: [...new Set(unjudged)] } : {}),
  };
}

export const notAvailable = (reason: string): DqRuleOutcome => ({
  status: "not_available",
  reason,
  issues: [],
  checked: 0,
  truncated: false,
  total: 0,
});

export const notConfigured = (reason: string): DqRuleOutcome => ({
  status: "not_configured",
  reason,
  issues: [],
  checked: 0,
  truncated: false,
  total: 0,
});

/** The numeric threshold of a rule (the default when the stored value is not a number). */
export function numberThreshold(t: DqThreshold, fallback: number): number {
  return typeof t === "number" && Number.isFinite(t) ? t : fallback;
}
