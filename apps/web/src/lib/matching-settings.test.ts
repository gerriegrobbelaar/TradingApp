import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_CONFIG,
  REGEX_PROBLEM_CODES,
  safeRegexTest,
  unsafeRegexReason,
  validateMatchConfig,
} from "@camelthorn/core";
import { TUNABLES } from "../test-fixtures-matching";
import {
  EMPTY_PATTERN,
  checkPattern,
  checkTunables,
  plainProblem,
  REGEX_PROBLEM,
  regexProblem,
  testPattern,
  toForm,
  type PatternForm,
} from "./matching-settings";

const form = (over: Record<string, string> = {}) => {
  const f = toForm(TUNABLES);
  return { ...f, numbers: { ...f.numbers, ...over } };
};

describe("thresholds mirror core validateMatchConfig", () => {
  it("accepts the defaults", () => {
    const c = checkTunables(toForm(TUNABLES));
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.value).toEqual(TUNABLES);
    expect(validateMatchConfig({ ...DEFAULT_MATCH_CONFIG })).toEqual([]);
  });

  it("the automatic score must be 95 to 100", () => {
    for (const bad of ["94", "101", "0", "-1", "95.5", "", "abc"]) {
      expect(checkTunables(form({ autoMatchMinScore: bad })).ok, bad).toBe(false);
    }
    expect(checkTunables(form({ autoMatchMinScore: "95" })).ok).toBe(true);
    expect(checkTunables(form({ autoMatchMinScore: "100" })).ok).toBe(true);
    const c = checkTunables(form({ autoMatchMinScore: "90" }));
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.problems.join(" ")).toBe(
        "Automatic match score must be a whole number from 95 to 100",
      );
      expect(c.fields.autoMatchMinScore).toMatch(/from 95 to 100/);
    }
  });

  it("the gap is 10 to 100; the suggestion score is at most the automatic score", () => {
    expect(checkTunables(form({ autoMatchMinGap: "9" })).ok).toBe(false);
    expect(checkTunables(form({ autoMatchMinGap: "10" })).ok).toBe(true);
    expect(checkTunables(form({ autoMatchMinGap: "101" })).ok).toBe(false);
    const c = checkTunables(form({ suggestMinScore: "99" }));
    expect(c.ok).toBe(false);
    if (!c.ok)
      expect(c.problems[0]).toBe(
        "suggestMinScore must be a whole number from 1 to the automatic match score".replace(
          "suggestMinScore",
          "Suggestion score",
        ),
      );
    expect(checkTunables(form({ suggestMinScore: "95" })).ok).toBe(true);
  });

  it("candidates 1 to 50, tolerance 0 to 100, days 30 to 3650", () => {
    expect(checkTunables(form({ maxCandidates: "0" })).ok).toBe(false);
    expect(checkTunables(form({ maxCandidates: "51" })).ok).toBe(false);
    expect(checkTunables(form({ amountToleranceMinor: "101" })).ok).toBe(false);
    expect(checkTunables(form({ amountToleranceMinor: "100" })).ok).toBe(true);
    expect(checkTunables(form({ blockAutoOnRecentIbanChangeDays: "3651" })).ok).toBe(false);
    expect(checkTunables(form({ blockAutoOnRecentIbanChangeDays: "29" })).ok).toBe(false);
    expect(checkTunables(form({ blockAutoOnRecentIbanChangeDays: "30" })).ok).toBe(true);
  });

  it("the lists must be lower-case words and not overlap", () => {
    const f = toForm(TUNABLES);
    const bad = checkTunables({ ...f, lists: { ...f.lists, autoTxTypes: "Transfer, x y" } });
    expect(bad.ok).toBe(false);
    const overlap = checkTunables({
      ...f,
      lists: { ...f.lists, autoTxTypes: "transfer, exchange" },
    });
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.problems.join(" ")).toMatch(/both auto and no-match/);
    const ok = checkTunables({
      ...f,
      lists: { ...f.lists, autoTxTypes: "transfer, transfer, fee" },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.autoTxTypes).toEqual(["transfer", "fee"]);
  });

  it("agrees with core on every number (no off-by-one in the mirror)", () => {
    const keys = [
      "autoMatchMinScore",
      "autoMatchMinGap",
      "suggestMinScore",
      "maxCandidates",
      "amountToleranceMinor",
      "blockAutoOnRecentIbanChangeDays",
    ] as const;
    for (const key of keys) {
      for (const v of [-1, 0, 1, 49, 50, 51, 94, 95, 96, 99, 100, 101, 3650, 3651]) {
        const mine = checkTunables(form({ [key]: String(v) })).ok;
        const ours = { ...TUNABLES, [key]: v };
        const core =
          v >= 0 &&
          validateMatchConfig({
            ...DEFAULT_MATCH_CONFIG,
            ...ours,
            amountToleranceMinor: BigInt(ours.amountToleranceMinor),
          }).length === 0;
        expect(mine, `${key}=${v}`).toBe(core);
      }
    }
  });

  it("plainProblem keeps unknown text as it is", () => {
    expect(plainProblem("something else")).toBe("something else");
  });
});

describe("ledger pattern regexes use the core safe subset", () => {
  it("explains each unsafe form in plain language", () => {
    const cases: [string, RegExp][] = [
      ["(a+)+$", /repeated group/],
      ["(a|b)*", /repeated group/],
      ["(a)\\1", /Back-references/],
      ["(?=a)b", /Look-ahead/],
      ["(?<=a)b", /Look-ahead/],
      ["a*b*c*", /at most two open-ended/],
      ["a{1,51}", /too large/],
      ["abc\\", /lone backslash/],
      ["[abc", /not closed/],
      ["(abc", /do not match/],
      ["*a", /nothing in front/],
      ["a".repeat(201), /too long/],
    ];
    for (const [src, re] of cases) {
      expect(unsafeRegexReason(src), src).not.toBeNull();
      expect(regexProblem(src), src).toMatch(re);
    }
    expect(regexProblem("^revolut")).toBeNull();
    expect(regexProblem("fee|commission")).toBeNull();
  });

  it("has its own sentence for exactly the reason codes core exports (review M7d)", () => {
    expect(Object.keys(REGEX_PROBLEM).sort()).toEqual([...REGEX_PROBLEM_CODES].sort());
    expect(new Set(Object.values(REGEX_PROBLEM)).size).toBe(REGEX_PROBLEM_CODES.length);
  });

  it("refuses exponential patterns before the test box can run them (cannot hang the tab)", () => {
    const evil = "(?:a|aa)".repeat(24) + "b";
    expect(regexProblem(evil)).toMatch(/too many optional parts/);
    const f: PatternForm = {
      ...EMPTY_PATTERN,
      name: "x",
      ledgerAccountCode: "1",
      referenceRegex: evil,
    };
    const t0 = Date.now();
    expect(testPattern(f, "a".repeat(5000))).toEqual([]);
    expect(safeRegexTest(evil, "a".repeat(5000))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("has a plain message for every reason core can give", () => {
    for (const src of [
      "",
      "(a+)+",
      "\\1",
      "(?=x)",
      "a*b*c*",
      "a{99}",
      "\\",
      "[a",
      "(a",
      "*",
      "x".repeat(300),
      "a{1",
      "(?x)",
    ]) {
      const r = unsafeRegexReason(src);
      if (r !== null) expect(regexProblem(src), `${src.slice(0, 10)} ${r}`).toMatch(/^[A-Z]/);
    }
  });

  const base: PatternForm = {
    ...EMPTY_PATTERN,
    name: "Bank costs",
    ledgerAccountCode: "4500",
    counterpartyNameRegex: "^revolut",
  };

  it("checks a form and builds the request", () => {
    const c = checkPattern(base);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.request).toEqual({
        name: "Bank costs",
        ledgerAccountCode: "4500",
        counterpartyNameRegex: "^revolut",
        referenceRegex: null,
        type: null,
        direction: null,
        maxAmountMinor: null,
        enabled: true,
      });
    }
  });

  it("refuses an empty condition, a bad account, a bad regex and a bad amount", () => {
    const none = checkPattern({ ...base, counterpartyNameRegex: "" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors.test).toMatch(/at least one condition/);
    const acct = checkPattern({ ...base, ledgerAccountCode: "45 00" });
    expect(acct.ok).toBe(false);
    const re = checkPattern({ ...base, referenceRegex: "(a+)+" });
    expect(re.ok).toBe(false);
    if (!re.ok) expect(re.errors.referenceRegex).toMatch(/repeated group/);
    for (const amt of ["0", "-5", "1.5", "abc", "1234567890123456"]) {
      expect(checkPattern({ ...base, maxAmountMinor: amt }).ok, amt).toBe(false);
    }
    expect(checkPattern({ ...base, maxAmountMinor: "2500" }).ok).toBe(true);
    expect(checkPattern({ ...base, type: "Card Payment" }).ok).toBe(false);
    expect(checkPattern({ ...base, name: " " }).ok).toBe(false);
  });

  it("tests text with the safe matcher, case-insensitively, on the filled-in regexes only", () => {
    const f = { ...base, referenceRegex: "fee$" };
    expect(testPattern(f, "Revolut Business")).toEqual([
      { field: "counterpartyNameRegex", label: "Counterparty name", matches: true },
      { field: "referenceRegex", label: "Reference", matches: false },
    ]);
    expect(testPattern({ ...base, counterpartyNameRegex: "(a+)+" }, "aaaa")).toEqual([]);
    expect(testPattern(EMPTY_PATTERN, "x")).toEqual([]);
    // a long input is cut by core, never slow
    expect(testPattern(base, "x".repeat(100000))[0]?.matches).toBe(false);
  });
});
