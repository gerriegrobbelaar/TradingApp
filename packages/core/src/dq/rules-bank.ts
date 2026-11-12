/** Bank area rules (CLAUDE.md 4.6; Phase 7 review S5, S10). Pure. */
import type { DqInput, DqIssue, DqRuleConfig, DqRuleDef, DqRuleOutcome } from "./types";
import {
  ageMs,
  amountText,
  cleanText,
  DAY_MS,
  finish,
  HOUR_MS,
  makeIssue,
  notAvailable,
  numberThreshold,
  plural,
  wholeDays,
} from "./util";

/** Both balances must be read within this long of each other to be compared. */
export const BALANCE_SKEW_MS = 3 * HOUR_MS;
/** An Exact balance older than this is not compared at all. */
export const EXACT_BALANCE_MAX_AGE_MS = 36 * HOUR_MS;

const balanceMismatch: DqRuleDef = {
  id: "bank.balance_mismatch",
  area: "bank",
  scope: "division",
  defaultSeverity: "warning",
  threshold: { kind: "number", unit: "minor", default: 100, min: 0, max: 100_000_000 },
  title: "Exact balance differs from the bank balance",
  description:
    "The balance of the bank ledger account in Exact differs from the balance the bank reports by more than the tolerance. Lines not yet booked in Exact explain most differences.",
  fix: "bank",
  evaluate(input, config) {
    const accounts = input.bankAccounts;
    if (accounts === null) return notAvailable("bank_accounts_not_loaded");
    const tolerance = numberThreshold(config.threshold, 100);
    const issues: DqIssue[] = [];
    let checked = 0;
    for (const a of accounts) {
      if (a.exactBalanceMinor === null || a.balanceMinor === null) continue;
      const exactAge = ageMs(input.nowMs, a.exactBalanceAt);
      const bankAt = a.balanceAt === null ? NaN : Date.parse(a.balanceAt);
      const exactAt = a.exactBalanceAt === null ? NaN : Date.parse(a.exactBalanceAt);
      if (exactAge === null || Number.isNaN(bankAt)) continue;
      // A stale Exact read, or two reads taken far apart, would raise differences that are only
      // timing: they are skipped, and a rule with nothing comparable is not_available below.
      if (exactAge > EXACT_BALANCE_MAX_AGE_MS || Math.abs(bankAt - exactAt) > BALANCE_SKEW_MS) {
        continue;
      }
      checked += 1;
      const diff = a.balanceMinor - a.exactBalanceMinor;
      if (!Number.isSafeInteger(diff) || Math.abs(diff) <= tolerance) continue;
      issues.push(
        makeIssue(this, config, ["acc", a.id], {
          subject: a.name,
          message: `${amountText(Math.abs(diff), a.currency)} difference between the bank and Exact on ${cleanText(a.name)}.`,
          amountMinor: diff,
          currency: a.currency,
          details: { bankMinor: a.balanceMinor, exactMinor: a.exactBalanceMinor },
        }),
      );
    }
    if (checked === 0) return notAvailable("no_comparable_exact_balance");
    return finish(issues, checked);
  },
};

const unmatchedOld: DqRuleDef = {
  id: "bank.unmatched_old",
  area: "bank",
  scope: "division",
  defaultSeverity: "warning",
  threshold: { kind: "number", unit: "days", default: 5, min: 1, max: 365 },
  title: "Bank lines unmatched for too long",
  description:
    "Completed bank lines that are neither matched nor ignored after the set number of days.",
  fix: "matching",
  evaluate(input, config) {
    if (input.bankTransactions === null) return notAvailable("bank_transactions_not_loaded");
    const days = numberThreshold(config.threshold, 5);
    const rows: { tx: (typeof input.bankTransactions)[number]; age: number }[] = [];
    for (const tx of input.bankTransactions) {
      if (tx.matchStatus === "matched" || tx.matchStatus === "ignored") continue;
      const age = ageMs(input.nowMs, tx.bookedAt);
      if (age === null || age <= days * DAY_MS) continue;
      rows.push({ tx, age });
    }
    rows.sort((a, b) => b.age - a.age || a.tx.id - b.tx.id);
    const issues = rows.map(({ tx, age }) => {
      const d = wholeDays(age);
      return makeIssue(this, config, ["tx", tx.id], {
        subject: tx.counterpartyName ?? `Bank line ${tx.id}`,
        message: `${amountText(tx.amountMinor, tx.currency)} unmatched for ${d} ${plural(d, "day", "days")}.`,
        amountMinor: tx.amountMinor,
        currency: tx.currency,
        details: { days: d, txId: tx.id },
      });
    });
    return finish(issues, input.bankTransactions.length);
  },
};

const duplicateLines: DqRuleDef = {
  id: "bank.duplicate_lines",
  area: "bank",
  scope: "division",
  defaultSeverity: "warning",
  threshold: null,
  title: "Possible duplicate bank lines",
  description:
    "Two or more bank lines of one account with the same amount, day, counterparty and reference. Two identical payments are possible; check that none was imported twice.",
  fix: "bank",
  evaluate(input, config) {
    if (input.bankTransactions === null) return notAvailable("bank_transactions_not_loaded");
    const groups = new Map<string, (typeof input.bankTransactions)[number][]>();
    for (const tx of input.bankTransactions) {
      const ref = (tx.reference ?? "").trim().toLowerCase();
      const who = (tx.counterpartyKey ?? "").trim().toLowerCase();
      // Without a reference and a counterparty two equal amounts say nothing.
      if (ref === "" || who === "") continue;
      const key = JSON.stringify([
        tx.accountId,
        tx.amountMinor,
        tx.currency,
        tx.bookedAt.slice(0, 10),
        who,
        ref,
      ]);
      const g = groups.get(key);
      if (g) g.push(tx);
      else groups.set(key, [tx]);
    }
    const issues: DqIssue[] = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => a.id - b.id);
      const first = g[0];
      if (first === undefined) continue;
      issues.push(
        makeIssue(this, config, ["dup", first.id], {
          subject: first.counterpartyName ?? `Bank line ${first.id}`,
          message: `${g.length} lines of ${amountText(first.amountMinor, first.currency)} on the same day with the same reference.`,
          amountMinor: first.amountMinor,
          currency: first.currency,
          details: { lines: g.length, firstTxId: first.id },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, input.bankTransactions.length);
  },
};

const bookedLineReverted: DqRuleDef = {
  id: "bank.booked_line_reverted",
  area: "bank",
  scope: "division",
  defaultSeverity: "critical",
  threshold: null,
  title: "Booked match whose bank line changed afterwards",
  description:
    "A match is booked in Exact, but the bank line later became reverted or got a state conflict. Exact and the bank no longer agree.",
  fix: "matching",
  evaluate(input, config) {
    if (input.bookedMatches === null) return notAvailable("matches_not_loaded");
    const issues: DqIssue[] = [];
    for (const m of input.bookedMatches) {
      const reverted = m.lineState === "reverted";
      if (!reverted && !m.stateConflict) continue;
      issues.push(
        makeIssue(this, config, ["match", m.matchId], {
          subject: `Match ${m.matchId}`,
          message: `${amountText(m.amountMinor, m.currency)} booked in Exact, but the bank line ${reverted ? "was reverted" : "has a state conflict"}.`,
          amountMinor: m.amountMinor,
          currency: m.currency,
          details: { reverted, conflict: m.stateConflict, matchId: m.matchId },
        }),
      );
    }
    issues.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint, "en", { numeric: true }));
    return finish(issues, input.bookedMatches.length);
  },
};

/** One issue per division with a count, for booking health numbers. */
function countRule(
  id: string,
  severity: DqRuleDef["defaultSeverity"],
  title: string,
  description: string,
  fix: DqRuleDef["fix"],
  read: (b: NonNullable<DqInput["booking"]>) => number,
  sentence: (n: number) => string,
): DqRuleDef {
  return {
    id,
    area: "bank",
    scope: "division",
    defaultSeverity: severity,
    threshold: { kind: "number", unit: "count", default: 0, min: 0, max: 100_000 },
    title,
    description,
    fix,
    evaluate(input: DqInput, config: DqRuleConfig): DqRuleOutcome {
      if (input.booking === null) return notAvailable("booking_health_not_loaded");
      const n = read(input.booking);
      const limit = numberThreshold(config.threshold, 0);
      if (!Number.isSafeInteger(n) || n <= limit) return finish([], 1);
      return finish(
        [
          makeIssue({ id, fix }, config, ["division"], {
            subject: "Booking health",
            message: sentence(n),
            details: { count: n },
          }),
        ],
        1,
      );
    },
  };
}

const outcomeUnknown = countRule(
  "bank.booking_outcome_unknown",
  "critical",
  "Booking with an unknown outcome",
  "A write to Exact may or may not have landed. Nothing is sent again until a person checks Exact.",
  "booking",
  (b) => b.outcomeUnknown,
  (n) => `${n} ${plural(n, "booking", "bookings")} with an unknown outcome in Exact.`,
);

const manualRequired = countRule(
  "bank.booking_manual_required",
  "warning",
  "Bookings that need a person",
  "Bookings the app stopped because Exact did not look as expected (item already settled, changed, or the mode changed).",
  "booking",
  (b) => b.manualRequired,
  (n) => `${n} ${plural(n, "booking needs", "bookings need")} a person.`,
);

const alreadyMatched = countRule(
  "bank.already_matched_in_exact",
  "warning",
  "Items closed in Exact before our match",
  "Matches whose items Exact had already closed when the MatchSet was prepared. A person checks that no payment was entered twice.",
  "booking",
  (b) => b.alreadyMatchedInExact,
  (n) => `${n} ${plural(n, "match", "matches")} found its items already closed in Exact.`,
);

const staleSettlements = countRule(
  "bank.stale_settlements",
  "warning",
  "Booked payments Exact has not shown",
  "Allocations of matches booked more than 48 hours ago still count against their invoice because a re-read of Exact does not show the payment.",
  "booking",
  (b) => b.staleSettlements,
  (n) =>
    `${n} booked ${plural(n, "payment is", "payments are")} not yet visible in Exact after 48 hours.`,
);

export const BANK_RULES: readonly DqRuleDef[] = [
  balanceMismatch,
  unmatchedOld,
  duplicateLines,
  bookedLineReverted,
  staleSettlements,
  outcomeUnknown,
  manualRequired,
  alreadyMatched,
];
