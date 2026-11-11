/**
 * Matching configuration: defaults, validation and safe regex compilation (ADR 0041). Pure.
 *
 * Ledger-pattern regexes come from Settings, so they are untrusted. JavaScript regexes backtrack,
 * so a pattern such as `(a+)+$` can take exponential time. Only a linear-friendly subset is
 * accepted:
 *  - at most 200 characters, compiles with flags `iu`;
 *  - no backreferences (`\1`, `\k<name>`) and no lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`);
 *  - no quantified group that itself contains a quantifier or an alternation (`(a+)+`, `(a|b)*`);
 *  - at most 2 unbounded quantifiers (`*`, `+`, `{n,}`), bounded repeats at most {0,50};
 *  - a backtracking budget (review M7d): the product of the choices of every bounded quantifier
 *    (`?` is 2, `{2,5}` is 4) and every alternation (`a|b|c` is 3) must stay at or below
 *    2^(12 - 5 x unbounded quantifiers), so 4096, 128 or 4. Without it, `a?a?a?...aaa` or `(?:a|aa)(?:a|aa)...b` stay
 *    inside the rules above but take exponential time (seconds to minutes in V8).
 * Inputs are cut to 256 characters before testing, which keeps the worst case polynomial and small.
 */
import type { LedgerPattern, MatchConfig } from "./types";

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  autoMatchMinScore: 95,
  autoMatchMinGap: 20,
  suggestMinScore: 50,
  maxCandidates: 5,
  amountToleranceMinor: 0n,
  blockAutoOnRecentIbanChangeDays: 90,
  autoIncomingUnknownIban: false,
  autoLedgerPatterns: false,
  patterns: [],
  autoTxTypes: ["transfer", "topup", "card_payment"],
  noMatchTxTypes: ["exchange"],
  internalAccountTypes: ["self"],
  ownIbans: [],
};

export const MAX_PATTERN_LENGTH = 200;
export const MAX_REGEX_INPUT = 256;
const MAX_UNBOUNDED = 2;
const MAX_REPEAT = 50;
/** log2 of the allowed product of bounded choices with no unbounded quantifier; each one costs 7. */
const CHOICE_BUDGET_LOG2 = 12;
const UNBOUNDED_COST_LOG2 = 5;

/** Every reason unsafeRegexReason can return (the web labels each one). */
export const REGEX_PROBLEM_CODES = [
  "empty",
  "too_long",
  "repeat_too_large",
  "nested_quantifier",
  "backreference",
  "lookaround",
  "too_many_unbounded_quantifiers",
  "too_complex",
  "trailing_escape",
  "bad_escape",
  "unclosed_class",
  "bad_group",
  "unbalanced",
  "nothing_to_repeat",
  "invalid",
] as const;
export type RegexProblemCode = (typeof REGEX_PROBLEM_CODES)[number];
/** CLAUDE.md 4.2: auto-match only when the top score is at least 95. */
export const MIN_AUTO_SCORE = 95;
export const MAX_TOLERANCE_MINOR = 100n;
/**
 * Floors (phase 7 review S3). CLAUDE.md 4.2 wants "the next candidate far behind": a gap below 10
 * points is not far, and a supplier IBAN changed less than 30 days ago is still inside the usual
 * window of invoice-redirection fraud. A configuration below a floor is invalid.
 */
export const MIN_AUTO_GAP = 10;
export const MIN_RECENT_IBAN_DAYS = 30;

/**
 * Every MatchConfig field, classified by what a change can do to AUTOMATIC matching (review U2).
 * The Record type makes a new field a compile error until it is classified here; a test derives
 * the keys from DEFAULT_MATCH_CONFIG as well.
 *   auto_safety  a change in one direction lets automatic matching do more: isLoosening checks it.
 *   neutral      cannot make a match automatic (display only, or applied after the decision).
 */
export const MATCH_CONFIG_FIELD_SAFETY: Record<keyof MatchConfig, "auto_safety" | "neutral"> = {
  autoMatchMinScore: "auto_safety", // lower = looser
  autoMatchMinGap: "auto_safety", // lower = looser
  // Neutral: the engine takes the runner-up for the gap from every candidate, shown or not.
  suggestMinScore: "neutral",
  // Neutral: the list is cut after the decision.
  maxCandidates: "neutral",
  amountToleranceMinor: "auto_safety", // higher = looser
  blockAutoOnRecentIbanChangeDays: "auto_safety", // fewer days = looser
  autoIncomingUnknownIban: "auto_safety", // false -> true = looser
  autoLedgerPatterns: "auto_safety", // false -> true = looser
  patterns: "auto_safety", // while ledger auto is on: any new or changed pattern
  autoTxTypes: "auto_safety", // a type added = looser
  noMatchTxTypes: "auto_safety", // a type removed = those lines become matchable
  internalAccountTypes: "auto_safety", // a type removed = own-account transfers matchable
  ownIbans: "auto_safety", // an IBAN removed = transfers from it matchable
};

/** A ledger pattern as isLoosening compares it (bigint or number amounts). */
type PatternLike = Omit<LedgerPattern, "test"> & {
  test: Omit<LedgerPattern["test"], "maxAmountMinor"> & { maxAmountMinor?: bigint | number };
};

/** The settings that decide how much an automatic match may do. */
export interface AutoSafetyFields {
  autoMatchMinScore: number;
  autoMatchMinGap: number;
  blockAutoOnRecentIbanChangeDays: number;
  autoLedgerPatterns: boolean;
  autoIncomingUnknownIban: boolean;
  /** Minor units; number (stored JSON) or bigint (engine config). */
  amountToleranceMinor: number | bigint;
  autoTxTypes?: readonly string[];
  noMatchTxTypes?: readonly string[];
  internalAccountTypes?: readonly string[];
  ownIbans?: readonly string[];
  /** Enabled ledger patterns; omitted when the caller does not change them. */
  patterns?: readonly PatternLike[];
}

const patternKey = (p: PatternLike): string =>
  JSON.stringify([
    p.ledgerAccountCode,
    p.test.counterpartyNameRegex ?? null,
    p.test.referenceRegex ?? null,
    p.test.type ?? null,
    p.test.direction ?? null,
    p.test.maxAmountMinor === undefined ? null : String(p.test.maxAmountMinor),
  ]);

/**
 * True when `next` lets automatic matching do MORE than `prev`: a lower score or gap, fewer days of
 * recent-IBAN protection, ledger patterns or unknown-IBAN incoming payments switched on, a larger
 * amount tolerance, a new transaction type that may be automatic, a no-match type, own-account
 * type or own IBAN removed, or (while ledger patterns may be automatic) a pattern that was not
 * there before in exactly this form. Tightening and neutral changes are not loosening. Pure.
 */
export function isLoosening(prev: AutoSafetyFields, next: AutoSafetyFields): boolean {
  if (next.autoMatchMinScore < prev.autoMatchMinScore) return true;
  if (next.autoMatchMinGap < prev.autoMatchMinGap) return true;
  if (next.blockAutoOnRecentIbanChangeDays < prev.blockAutoOnRecentIbanChangeDays) return true;
  if (next.autoLedgerPatterns && !prev.autoLedgerPatterns) return true;
  if (next.autoIncomingUnknownIban && !prev.autoIncomingUnknownIban) return true;
  if (BigInt(next.amountToleranceMinor) > BigInt(prev.amountToleranceMinor)) return true;
  const added = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
    const before = new Set(a ?? []);
    return (b ?? []).some((t) => !before.has(t));
  };
  if (added(prev.autoTxTypes, next.autoTxTypes)) return true;
  // Removed from a "never match" list = added to what may match.
  if (added(next.noMatchTxTypes, prev.noMatchTxTypes)) return true;
  if (added(next.internalAccountTypes, prev.internalAccountTypes)) return true;
  const norm = (l: readonly string[] | undefined) =>
    (l ?? []).map((i) => i.replace(/\s+/g, "").toUpperCase());
  if (added(norm(next.ownIbans), norm(prev.ownIbans))) return true;
  if (next.autoLedgerPatterns && next.patterns !== undefined) {
    const before = new Set((prev.patterns ?? []).map(patternKey));
    if (next.patterns.some((p) => !before.has(patternKey(p)))) return true;
  }
  return false;
}

/** Reason the regex is outside the safe subset, or null when it is acceptable. */
export function unsafeRegexReason(src: string): RegexProblemCode | null {
  if (src.length === 0) return "empty";
  if (src.length > MAX_PATTERN_LENGTH) return "too_long";
  interface Frame {
    quant: boolean;
    alt: boolean;
    /** Number of `|` directly in this group. */
    bars: number;
  }
  const stack: Frame[] = [{ quant: false, alt: false, bars: 0 }];
  let unbounded = 0;
  /** Product of bounded choices, saturated far above any budget (integers, no overflow). */
  let choices = 1;
  const SATURATE = 2 ** CHOICE_BUDGET_LOG2 + 1;
  const times = (k: number): void => {
    choices = Math.min(SATURATE, choices * Math.max(1, k));
  };
  let i = 0;
  /** Parses a quantifier at i; returns [length, unbounded, choices] or null. */
  const quantAt = (at: number): [number, boolean, number] | null | "bad" => {
    const c = src[at];
    if (c === "*" || c === "+") return [1, true, 1];
    if (c === "?") return [1, false, 2];
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(at));
      if (!m) return null;
      const min = Number(m[1]);
      if (m[2] === undefined) return min > MAX_REPEAT ? "bad" : [m[0].length, false, 1];
      if (m[3] === undefined || m[3] === "") return [m[0].length, true, 1];
      const max = Number(m[3]);
      return max > MAX_REPEAT ? "bad" : [m[0].length, false, max - min + 1];
    }
    return null;
  };
  /** After an atom ending at i (exclusive), consume an optional quantifier. */
  const afterAtom = (atomHasQuantOrAlt: boolean): RegexProblemCode | null => {
    const q = quantAt(i);
    if (q === "bad") return "repeat_too_large";
    if (q === null) return null;
    if (atomHasQuantOrAlt) return "nested_quantifier";
    i += q[0];
    if (src[i] === "?") i++; // lazy
    if (q[1]) unbounded++;
    else times(q[2]);
    const top = stack[stack.length - 1];
    if (top) top.quant = true;
    if (quantAt(i) !== null) return "nested_quantifier";
    return null;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) return "trailing_escape";
      if (/[1-9]/.test(n) || n === "k") return "backreference";
      i += 2;
      if (n === "u" && src[i] === "{") {
        const close = src.indexOf("}", i);
        if (close < 0) return "bad_escape";
        i = close + 1;
      }
      const r = afterAtom(false);
      if (r) return r;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++;
      while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return "unclosed_class";
      i = j + 1;
      const r = afterAtom(false);
      if (r) return r;
      continue;
    }
    if (c === "(") {
      if (src[i + 1] === "?") {
        const mod = src.slice(i + 2, i + 4);
        if (mod.startsWith("=") || mod.startsWith("!") || mod === "<=" || mod === "<!") {
          return "lookaround";
        }
      }
      stack.push({ quant: false, alt: false, bars: 0 });
      i++;
      if (src[i] === "?") {
        // (?: or (?<name>
        if (src[i + 1] === ":") i += 2;
        else if (src[i + 1] === "<") {
          const close = src.indexOf(">", i);
          if (close < 0) return "bad_group";
          i = close + 1;
        } else return "bad_group";
      }
      continue;
    }
    if (c === ")") {
      const g = stack.pop();
      if (!g || stack.length === 0) return "unbalanced";
      times(g.bars + 1);
      i++;
      const r = afterAtom(g.quant || g.alt);
      if (r) return r;
      const parent = stack[stack.length - 1];
      if (parent && g.quant) parent.quant = true;
      continue;
    }
    if (c === "|") {
      const top = stack[stack.length - 1];
      if (top) {
        top.alt = true;
        top.bars++;
      }
      i++;
      continue;
    }
    if (quantAt(i) !== null && c !== "{") return "nothing_to_repeat";
    i++;
    const r = afterAtom(false);
    if (r) return r;
  }
  if (stack.length !== 1) return "unbalanced";
  if (unbounded > MAX_UNBOUNDED) return "too_many_unbounded_quantifiers";
  times((stack[0] as Frame).bars + 1);
  if (choices > 2 ** (CHOICE_BUDGET_LOG2 - UNBOUNDED_COST_LOG2 * unbounded)) return "too_complex";
  try {
    new RegExp(src, "iu");
  } catch {
    return "invalid";
  }
  return null;
}

const compiled = new Map<string, RegExp | null>();

/** Compiles a pattern from the safe subset (flags `iu`), null when unsafe or invalid. Cached. */
export function compileSafeRegex(src: string): RegExp | null {
  const hit = compiled.get(src);
  if (hit !== undefined) return hit;
  let re: RegExp | null = null;
  if (unsafeRegexReason(src) === null) {
    try {
      re = new RegExp(src, "iu");
    } catch {
      re = null;
    }
  }
  if (compiled.size > 500) compiled.clear();
  compiled.set(src, re);
  return re;
}

/** Tests an untrusted regex on at most `MAX_REGEX_INPUT` characters; false when unsafe. */
export function safeRegexTest(src: string, input: string | null): boolean {
  if (input === null) return false;
  const re = compileSafeRegex(src);
  return re !== null && re.test(input.slice(0, MAX_REGEX_INPUT));
}

const isInt = (n: number, min: number, max: number): boolean =>
  Number.isInteger(n) && n >= min && n <= max;

function patternErrors(p: LedgerPattern, idx: number): string[] {
  const out: string[] = [];
  const at = `patterns[${idx}]`;
  if (!p.id) out.push(`${at}.id is empty`);
  if (!/^[0-9A-Za-z.-]{1,20}$/.test(p.ledgerAccountCode)) {
    out.push(`${at}.ledgerAccountCode is not a ledger account code`);
  }
  const t = p.test;
  const hasTest =
    t.counterpartyNameRegex !== undefined ||
    t.referenceRegex !== undefined ||
    t.type !== undefined ||
    t.direction !== undefined ||
    t.maxAmountMinor !== undefined;
  if (!hasTest) out.push(`${at} has no test`);
  for (const key of ["counterpartyNameRegex", "referenceRegex"] as const) {
    const src = t[key];
    if (src === undefined) continue;
    const why = unsafeRegexReason(src);
    if (why !== null) out.push(`${at}.${key} is not allowed (${why})`);
  }
  if (t.maxAmountMinor !== undefined && t.maxAmountMinor <= 0n) {
    out.push(`${at}.maxAmountMinor must be positive`);
  }
  return out;
}

/** Every problem with the configuration; empty when it is safe to use. */
export function validateMatchConfig(cfg: MatchConfig): string[] {
  const out: string[] = [];
  if (!isInt(cfg.autoMatchMinScore, MIN_AUTO_SCORE, 100)) {
    out.push(`autoMatchMinScore must be an integer from ${MIN_AUTO_SCORE} to 100`);
  }
  if (!isInt(cfg.autoMatchMinGap, MIN_AUTO_GAP, 100))
    out.push(`autoMatchMinGap must be an integer from ${MIN_AUTO_GAP} to 100`);
  if (!isInt(cfg.suggestMinScore, 1, 100) || cfg.suggestMinScore > cfg.autoMatchMinScore) {
    out.push("suggestMinScore must be an integer from 1 to autoMatchMinScore");
  }
  if (!isInt(cfg.maxCandidates, 1, 50)) out.push("maxCandidates must be an integer from 1 to 50");
  if (
    typeof cfg.amountToleranceMinor !== "bigint" ||
    cfg.amountToleranceMinor < 0n ||
    cfg.amountToleranceMinor > MAX_TOLERANCE_MINOR
  ) {
    out.push(`amountToleranceMinor must be from 0 to ${MAX_TOLERANCE_MINOR}`);
  }
  if (!isInt(cfg.blockAutoOnRecentIbanChangeDays, MIN_RECENT_IBAN_DAYS, 3650)) {
    out.push(
      `blockAutoOnRecentIbanChangeDays must be an integer from ${MIN_RECENT_IBAN_DAYS} to 3650`,
    );
  }
  if (typeof cfg.autoIncomingUnknownIban !== "boolean") {
    out.push("autoIncomingUnknownIban must be true or false");
  }
  const ids = new Set<string>();
  cfg.patterns.forEach((p, i) => {
    if (ids.has(p.id)) out.push(`patterns[${i}].id is a duplicate`);
    ids.add(p.id);
    out.push(...patternErrors(p, i));
  });
  for (const t of cfg.autoTxTypes) {
    if (cfg.noMatchTxTypes.includes(t)) out.push(`transaction type ${t} is both auto and no-match`);
  }
  return out;
}

/** Throws a RangeError listing every problem; matching never runs on an unsafe configuration. */
export function assertMatchConfig(cfg: MatchConfig): void {
  const errors = validateMatchConfig(cfg);
  if (errors.length > 0) throw new RangeError(`invalid match config: ${errors.join("; ")}`);
}
