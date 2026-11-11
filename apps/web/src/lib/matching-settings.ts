/**
 * Settings, Matching: form validation that REUSES the core rules (validateMatchConfig for the
 * thresholds, unsafeRegexReason / safeRegexTest for ledger patterns) and says the problems in
 * plain language. The server validates again; this only tells the person before they save.
 */
import {
  DEFAULT_MATCH_CONFIG,
  type RegexProblemCode,
  safeRegexTest,
  unsafeRegexReason,
  validateMatchConfig,
  type MatchPatternRequest,
  type MatchTunablesDto,
} from "@camelthorn/core";

// ---- thresholds --------------------------------------------------------------------------------

export type TunableNumberKey =
  | "autoMatchMinScore"
  | "autoMatchMinGap"
  | "suggestMinScore"
  | "maxCandidates"
  | "amountToleranceMinor"
  | "blockAutoOnRecentIbanChangeDays";
export type TunableListKey = "autoTxTypes" | "noMatchTxTypes" | "internalAccountTypes";

export const NUMBER_FIELDS: readonly { key: TunableNumberKey; label: string; hint: string }[] = [
  {
    key: "autoMatchMinScore",
    label: "Automatic match score",
    hint: "From 95 to 100. A line is matched automatically only at or above this score.",
  },
  {
    key: "autoMatchMinGap",
    label: "Gap to the next candidate",
    hint: "From 1 to 100. The runner-up must score at least this far behind.",
  },
  {
    key: "suggestMinScore",
    label: "Suggestion score",
    hint: "From 1 up to the automatic score. Lower scores are not shown as suggestions.",
  },
  { key: "maxCandidates", label: "Candidates per line", hint: "From 1 to 50." },
  {
    key: "amountToleranceMinor",
    label: "Amount tolerance (minor units)",
    hint: "From 0 to 100, in cents. 0 means the amount must be exact.",
  },
  {
    key: "blockAutoOnRecentIbanChangeDays",
    label: "Days after a supplier account change",
    hint: "From 0 to 3650. Payments to a recently changed account are never automatic.",
  },
];

export const LIST_FIELDS: readonly { key: TunableListKey; label: string; hint: string }[] = [
  {
    key: "autoTxTypes",
    label: "Types that may be automatic",
    hint: "Lower-case words separated by commas, for example transfer, card_payment.",
  },
  {
    key: "noMatchTxTypes",
    label: "Types that are never matched",
    hint: "For example exchange.",
  },
  {
    key: "internalAccountTypes",
    label: "Own-account types",
    hint: "Counterparty account types that mean our own account.",
  },
];

export interface TunablesForm {
  numbers: Record<TunableNumberKey, string>;
  autoLedgerPatterns: boolean;
  lists: Record<TunableListKey, string>;
}

export function toForm(t: MatchTunablesDto): TunablesForm {
  return {
    numbers: {
      autoMatchMinScore: String(t.autoMatchMinScore),
      autoMatchMinGap: String(t.autoMatchMinGap),
      suggestMinScore: String(t.suggestMinScore),
      maxCandidates: String(t.maxCandidates),
      amountToleranceMinor: String(t.amountToleranceMinor),
      blockAutoOnRecentIbanChangeDays: String(t.blockAutoOnRecentIbanChangeDays),
    },
    autoLedgerPatterns: t.autoLedgerPatterns,
    lists: {
      autoTxTypes: t.autoTxTypes.join(", "),
      noMatchTxTypes: t.noMatchTxTypes.join(", "),
      internalAccountTypes: t.internalAccountTypes.join(", "),
    },
  };
}

const LABEL_OF: Record<string, string> = Object.fromEntries([
  ...NUMBER_FIELDS.map((f) => [f.key, f.label] as const),
  ...LIST_FIELDS.map((f) => [f.key, f.label] as const),
]);

/** Core's English problem text in the words of this screen. */
export function plainProblem(problem: string): string {
  let out = problem.replace(/must be an integer from/g, "must be a whole number from");
  out = out.replace(/\bautoMatchMinScore\b/g, (m, offset: number) =>
    offset === 0 ? "Automatic match score" : "the automatic match score",
  );
  for (const [key, label] of Object.entries(LABEL_OF)) {
    out = out.replace(new RegExp(`^${key}\\b`), label);
  }
  return out;
}

export type TunablesCheck =
  | { ok: true; value: MatchTunablesDto; problems: [] }
  | {
      ok: false;
      problems: string[];
      fields: Partial<Record<TunableNumberKey | TunableListKey, string>>;
    };

const WHOLE = /^\d{1,9}$/;
const WORD = /^[a-z][a-z0-9_]{0,31}$/;

function parseList(text: string): string[] | null {
  const parts = text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length > 20 || !parts.every((p) => WORD.test(p))) return null;
  return [...new Set(parts)];
}

/** Checks the form with the core rules. On success `value` is what PUT /api/matching/config takes. */
export function checkTunables(form: TunablesForm): TunablesCheck {
  const fields: Partial<Record<TunableNumberKey | TunableListKey, string>> = {};
  const nums = {} as Record<TunableNumberKey, number>;
  for (const f of NUMBER_FIELDS) {
    const raw = form.numbers[f.key].trim();
    if (!WHOLE.test(raw)) fields[f.key] = `${f.label} must be a whole number.`;
    else nums[f.key] = Number(raw);
  }
  const lists = {} as Record<TunableListKey, string[]>;
  for (const f of LIST_FIELDS) {
    const parsed = parseList(form.lists[f.key]);
    if (parsed === null) {
      fields[f.key] = `${f.label}: use up to 20 lower-case words (letters, digits, underscore).`;
    } else lists[f.key] = parsed;
  }
  if (Object.keys(fields).length > 0) return { ok: false, problems: Object.values(fields), fields };

  const value: MatchTunablesDto = {
    ...nums,
    autoLedgerPatterns: form.autoLedgerPatterns,
    ...lists,
  };
  const problems = validateMatchConfig({
    ...DEFAULT_MATCH_CONFIG,
    autoMatchMinScore: value.autoMatchMinScore,
    autoMatchMinGap: value.autoMatchMinGap,
    suggestMinScore: value.suggestMinScore,
    maxCandidates: value.maxCandidates,
    amountToleranceMinor: BigInt(value.amountToleranceMinor),
    blockAutoOnRecentIbanChangeDays: value.blockAutoOnRecentIbanChangeDays,
    autoLedgerPatterns: value.autoLedgerPatterns,
    autoTxTypes: value.autoTxTypes,
    noMatchTxTypes: value.noMatchTxTypes,
    internalAccountTypes: value.internalAccountTypes,
    patterns: [],
    ownIbans: [],
  });
  if (problems.length === 0) return { ok: true, value, problems: [] };
  const plain = problems.map(plainProblem);
  for (const p of problems) {
    for (const key of Object.keys(LABEL_OF)) {
      if (p.startsWith(key) && !(key in fields)) {
        fields[key as TunableNumberKey | TunableListKey] = plainProblem(p);
      }
    }
  }
  return { ok: false, problems: plain, fields };
}

// ---- ledger patterns ---------------------------------------------------------------------------

/** Every core reason has a sentence (the Record type fails the build when core adds one). */
export const REGEX_PROBLEM: Record<RegexProblemCode, string> = {
  empty: "Type a pattern, or leave this empty.",
  too_long: "The pattern is too long (200 characters at most).",
  repeat_too_large: "A repeat count is too large (50 at most).",
  nested_quantifier:
    "A repeated group contains another repeat or a choice, which can make matching very slow. Simplify it.",
  backreference: "Back-references such as \\1 are not allowed.",
  lookaround: "Look-ahead and look-behind groups are not allowed.",
  too_many_unbounded_quantifiers: "Use at most two open-ended repeats (*, + or {n,}).",
  too_complex:
    "This pattern has too many optional parts or choices, which can make matching very slow. Simplify it.",
  trailing_escape: "The pattern ends with a lone backslash.",
  bad_escape: "An escape sequence is not complete.",
  unclosed_class: "A character class [ ... ] is not closed.",
  bad_group: "A group uses a form that is not allowed. Use plain ( ... ) or (?: ... ).",
  unbalanced: "The brackets do not match up.",
  nothing_to_repeat: "A repeat has nothing in front of it.",
  invalid: "This is not a valid pattern.",
};

/** Plain-language problem with a regex source, or null when it is inside the safe subset. */
export function regexProblem(src: string): string | null {
  const why = unsafeRegexReason(src);
  if (why === null) return null;
  return Object.prototype.hasOwnProperty.call(REGEX_PROBLEM, why)
    ? REGEX_PROBLEM[why]
    : "This pattern is not allowed. Simplify it.";
}

export interface PatternForm {
  name: string;
  ledgerAccountCode: string;
  counterpartyNameRegex: string;
  referenceRegex: string;
  type: string;
  direction: "" | "in" | "out";
  maxAmountMinor: string;
  enabled: boolean;
}

export const EMPTY_PATTERN: PatternForm = {
  name: "",
  ledgerAccountCode: "",
  counterpartyNameRegex: "",
  referenceRegex: "",
  type: "",
  direction: "",
  maxAmountMinor: "",
  enabled: true,
};

export const LEDGER_CODE = /^[0-9A-Za-z.-]{1,20}$/;
export const JOURNAL_CODE = /^[0-9A-Za-z._-]{1,10}$/;
const TYPE_WORD = /^[a-z][a-z0-9_]{0,39}$/;

export type PatternCheck =
  | { ok: true; request: MatchPatternRequest }
  | { ok: false; errors: Partial<Record<keyof PatternForm | "test", string>> };

export function checkPattern(f: PatternForm): PatternCheck {
  const errors: Partial<Record<keyof PatternForm | "test", string>> = {};
  const name = f.name.trim();
  if (name === "" || name.length > 80) errors.name = "Give it a name of up to 80 characters.";
  if (!LEDGER_CODE.test(f.ledgerAccountCode.trim())) {
    errors.ledgerAccountCode = "Use the ledger account code: letters, digits, dots or hyphens.";
  }
  for (const key of ["counterpartyNameRegex", "referenceRegex"] as const) {
    const src = f[key];
    if (src !== "") {
      const p = regexProblem(src);
      if (p !== null) errors[key] = p;
    }
  }
  const type = f.type.trim();
  if (type !== "" && !TYPE_WORD.test(type)) {
    errors.type = "Use a lower-case word such as card_payment.";
  }
  const max = f.maxAmountMinor.trim();
  if (max !== "" && !/^[1-9]\d{0,14}$/.test(max)) {
    errors.maxAmountMinor = "Use a whole number of minor units, more than zero.";
  }
  const hasTest =
    f.counterpartyNameRegex !== "" ||
    f.referenceRegex !== "" ||
    type !== "" ||
    f.direction !== "" ||
    max !== "";
  if (!hasTest) errors.test = "Add at least one condition, or the pattern would match everything.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    request: {
      name,
      ledgerAccountCode: f.ledgerAccountCode.trim(),
      counterpartyNameRegex: f.counterpartyNameRegex === "" ? null : f.counterpartyNameRegex,
      referenceRegex: f.referenceRegex === "" ? null : f.referenceRegex,
      type: type === "" ? null : type,
      direction: f.direction === "" ? null : f.direction,
      maxAmountMinor: max === "" ? null : Number(max),
      enabled: f.enabled,
    },
  };
}

export interface PatternTestResult {
  field: "counterpartyNameRegex" | "referenceRegex";
  label: string;
  matches: boolean;
}

/** Runs each filled-in regex against the text with core's safe matcher (same subset as the server). */
export function testPattern(f: PatternForm, text: string): PatternTestResult[] {
  const out: PatternTestResult[] = [];
  if (f.counterpartyNameRegex !== "" && regexProblem(f.counterpartyNameRegex) === null) {
    out.push({
      field: "counterpartyNameRegex",
      label: "Counterparty name",
      matches: safeRegexTest(f.counterpartyNameRegex, text),
    });
  }
  if (f.referenceRegex !== "" && regexProblem(f.referenceRegex) === null) {
    out.push({
      field: "referenceRegex",
      label: "Reference",
      matches: safeRegexTest(f.referenceRegex, text),
    });
  }
  return out;
}
