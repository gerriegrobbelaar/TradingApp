/**
 * Matching configuration: defaults, validation and safe regex compilation (ADR 0041). Pure.
 *
 * Ledger-pattern regexes come from Settings, so they are untrusted. JavaScript regexes backtrack,
 * so a pattern such as `(a+)+$` can take exponential time. Only a linear-friendly subset is
 * accepted:
 *  - at most 200 characters, compiles with flags `iu`;
 *  - no backreferences (`\1`, `\k<name>`) and no lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`);
 *  - no quantified group that itself contains a quantifier or an alternation (`(a+)+`, `(a|b)*`);
 *  - at most 2 unbounded quantifiers (`*`, `+`, `{n,}`), bounded repeats at most {0,50}.
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
/** CLAUDE.md 4.2: auto-match only when the top score is at least 95. */
export const MIN_AUTO_SCORE = 95;
export const MAX_TOLERANCE_MINOR = 100n;

/** Reason the regex is outside the safe subset, or null when it is acceptable. */
export function unsafeRegexReason(src: string): string | null {
  if (src.length === 0) return "empty";
  if (src.length > MAX_PATTERN_LENGTH) return "too_long";
  interface Frame {
    quant: boolean;
    alt: boolean;
  }
  const stack: Frame[] = [{ quant: false, alt: false }];
  let unbounded = 0;
  let i = 0;
  /** Parses a quantifier at i; returns [length, unbounded, max] or null. */
  const quantAt = (at: number): [number, boolean] | null | "bad" => {
    const c = src[at];
    if (c === "*" || c === "+") return [1, true];
    if (c === "?") return [1, false];
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(at));
      if (!m) return null;
      const min = Number(m[1]);
      if (m[2] === undefined) return min > MAX_REPEAT ? "bad" : [m[0].length, false];
      if (m[3] === undefined || m[3] === "") return [m[0].length, true];
      return Number(m[3]) > MAX_REPEAT ? "bad" : [m[0].length, false];
    }
    return null;
  };
  /** After an atom ending at i (exclusive), consume an optional quantifier. */
  const afterAtom = (atomHasQuantOrAlt: boolean): string | null => {
    const q = quantAt(i);
    if (q === "bad") return "repeat_too_large";
    if (q === null) return null;
    if (atomHasQuantOrAlt) return "nested_quantifier";
    i += q[0];
    if (src[i] === "?") i++; // lazy
    if (q[1]) unbounded++;
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
      stack.push({ quant: false, alt: false });
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
      i++;
      const r = afterAtom(g.quant || g.alt);
      if (r) return r;
      const parent = stack[stack.length - 1];
      if (parent && g.quant) parent.quant = true;
      continue;
    }
    if (c === "|") {
      const top = stack[stack.length - 1];
      if (top) top.alt = true;
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
  if (!isInt(cfg.autoMatchMinGap, 1, 100))
    out.push("autoMatchMinGap must be an integer from 1 to 100");
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
  if (!isInt(cfg.blockAutoOnRecentIbanChangeDays, 0, 3650)) {
    out.push("blockAutoOnRecentIbanChangeDays must be an integer from 0 to 3650");
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
