/**
 * Shared ledger types and arithmetic for the balance sheet and profit and loss builders (pure, no
 * I/O). Everything is integer minor units of ONE currency, the division currency (ADR 0023); the
 * builders never see or add two currencies. Aggregates are summed as BigInt and converted back only
 * if they are safe integers, so a large ledger can never silently lose cents.
 *
 * SIGN CONVENTION of stored amounts (assumption, verify with credentials, ADR 0023):
 * `amountMinor` = debit - credit. Assets and costs are normally positive, liabilities, equity and
 * revenue normally negative. The reports flip the sign for display, per section.
 */
export type BalanceSemantics = "movement" | "cumulative";

/**
 * What a reporting balance row means (ADR 0023, assumption to verify with credentials):
 *  - "movement":   the net movement of that period. A balance sheet account's balance at period P
 *                  is the sum of periods 0..P (period 0 holds the brought-forward balance), a profit
 *                  and loss account's year-to-date figure the sum of periods 1..P.
 *  - "cumulative": the row already is the balance at the end of that period (year to date); the
 *                  report takes the latest period at or before P.
 * One constant, so a finding on the first live connection is a one-line change plus its test.
 */
export const LEDGER_BALANCE_SEMANTICS: BalanceSemantics = "movement";

export interface LedgerAccount {
  /** Exact GUID, lower case. */
  exactId: string;
  code: string | null;
  name: string;
  /** Exact's numeric GLAccount.Type. */
  type: number | null;
  typeDescription: string | null;
  balanceSide: "D" | "C" | null;
  /** 'B' balance sheet, 'W' profit and loss. */
  balanceType: "B" | "W" | null;
  isActive: boolean;
}

/** One stored reporting balance row (several rows per account and period are added up). */
export interface LedgerBalance {
  glAccountExactId: string;
  year: number;
  period: number;
  amountMinor: number;
  balanceType: "B" | "W" | null;
}

export interface LedgerBudget {
  glAccountExactId: string;
  year: number;
  period: number;
  amountMinor: number;
}

/** A line of a report: an account and its figures. */
export interface ReportAccountRef {
  accountId: string;
  code: string | null;
  name: string;
}

/** Highest period number that can occur (the table allows 0..99). */
export const LAST_PERIOD = 99;

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** BigInt to number, refusing anything beyond the safe integer range (never rounds). */
export function toSafe(v: bigint): number {
  if (v > MAX || v < -MAX) throw new RangeError("amount exceeds the safe integer range");
  return v === 0n ? 0 : Number(v);
}

export function sumMinor(values: Iterable<number>): number {
  let t = 0n;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new RangeError("minor units must be a safe integer");
    t += BigInt(v);
  }
  return toSafe(t);
}

/**
 * Variance as integer basis points of |base| (1 % = 100), rounded half away from zero, or null
 * when the base is zero (no division by zero, and "n/a" is the honest answer).
 */
export function varianceBps(variance: number, base: number): number | null {
  if (base === 0) return null;
  const num = BigInt(variance) * 10_000n;
  const den = BigInt(base < 0 ? -base : base);
  const abs = num < 0n ? -num : num;
  const q = (2n * abs + den) / (2n * den);
  return toSafe(num < 0n ? -q : q);
}

export interface PeriodRange {
  from: number;
  to: number;
}

/**
 * Signed (debit - credit) value per account for one year and period range under `semantics`.
 * Rows of the same account and period (cost centre or status splits) are added first.
 */
export function signedByAccount(
  balances: readonly LedgerBalance[],
  year: number,
  range: PeriodRange,
  semantics: BalanceSemantics,
): Map<string, bigint> {
  const perPeriod = new Map<string, Map<number, bigint>>();
  for (const b of balances) {
    if (b.year !== year || b.period < range.from || b.period > range.to) continue;
    if (!Number.isSafeInteger(b.amountMinor)) throw new RangeError("amount must be a safe integer");
    const periods = perPeriod.get(b.glAccountExactId) ?? new Map<number, bigint>();
    periods.set(b.period, (periods.get(b.period) ?? 0n) + BigInt(b.amountMinor));
    perPeriod.set(b.glAccountExactId, periods);
  }
  const out = new Map<string, bigint>();
  for (const [id, periods] of perPeriod) {
    if (semantics === "movement") {
      let t = 0n;
      for (const v of periods.values()) t += v;
      out.set(id, t);
    } else {
      const latest = Math.max(...periods.keys());
      out.set(id, periods.get(latest) ?? 0n);
    }
  }
  return out;
}

const collator = new Intl.Collator("en", { numeric: true });

/** Stable report order: by account code (numeric-aware, none last), then name, then id. */
export function compareRefs(a: ReportAccountRef, b: ReportAccountRef): number {
  if (a.code !== b.code) {
    if (a.code === null) return 1;
    if (b.code === null) return -1;
    const c = collator.compare(a.code, b.code);
    if (c !== 0) return c;
  }
  const n = collator.compare(a.name, b.name);
  if (n !== 0) return n;
  return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
}

/** Account facts the builders need, for accounts that are not in the chart (orphans) too. */
export interface ResolvedAccount extends ReportAccountRef {
  type: number | null;
  typeDescription: string | null;
  balanceSide: "D" | "C" | null;
  balanceType: "B" | "W";
  inChart: boolean;
}

/**
 * Every account that has a balance or budget row, resolved against the chart. An account that is
 * not in the chart is kept (never dropped: totals must reconcile) and called "Unknown account";
 * its balance type comes from its rows (B when they do not say, the side that the check line
 * surfaces).
 */
export function resolveAccounts(
  accounts: readonly LedgerAccount[],
  rows: readonly { glAccountExactId: string; balanceType?: "B" | "W" | null }[],
): Map<string, ResolvedAccount> {
  const out = new Map<string, ResolvedAccount>();
  const byId = new Map(accounts.map((a) => [a.exactId, a]));
  const typeFromRows = new Map<string, "B" | "W">();
  const ids = new Set<string>(accounts.map((a) => a.exactId));
  for (const r of rows) {
    ids.add(r.glAccountExactId);
    if (r.balanceType != null && !typeFromRows.has(r.glAccountExactId)) {
      typeFromRows.set(r.glAccountExactId, r.balanceType);
    }
  }
  for (const id of ids) {
    const a = byId.get(id);
    if (a !== undefined) {
      out.set(id, {
        accountId: id,
        code: a.code,
        name: a.name,
        type: a.type,
        typeDescription: a.typeDescription,
        balanceSide: a.balanceSide,
        balanceType: a.balanceType ?? typeFromRows.get(id) ?? "B",
        inChart: true,
      });
    } else {
      out.set(id, {
        accountId: id,
        code: null,
        name: `Unknown account ${id.slice(0, 8)}`,
        type: null,
        typeDescription: null,
        balanceSide: null,
        balanceType: typeFromRows.get(id) ?? "B",
        inChart: false,
      });
    }
  }
  return out;
}
