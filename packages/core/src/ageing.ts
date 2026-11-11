/**
 * Ageing of open items (pure, no I/O). Money is integer minor units per currency; amounts in
 * different currencies are never added together (EUR-equivalents come with Phase 6, ADR 0022).
 *
 * Ageing basis is the DUE date, not the invoice date. Days overdue are whole Amsterdam calendar
 * days: `asOf - dueDate`. Due today is NOT overdue ("not_due"); one day late is "d1_30".
 */
import { amsterdamDate } from "./local-time";
import { addMoney, money } from "./money";

export const AGEING_BUCKETS = [
  "not_due",
  "d1_30",
  "d31_60",
  "d61_90",
  "d90_plus",
  "no_due_date",
] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar date `YYYY-MM-DD` (validated, so 2026-02-30 is rejected). A full ISO instant is
 * converted to its Amsterdam calendar date first. Throws RangeError for anything else.
 */
export function toCalendarDate(value: string): string {
  const date = value.includes("T") ? amsterdamDate(value) : value;
  const m = date === null ? null : DATE_RE.exec(date);
  if (date === null || m === null) throw new RangeError("not a calendar date");
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new RangeError("not a calendar date");
  return date;
}

/** Days since 1970-01-01 of a calendar date (no time zone involved). */
export function dayNumber(date: string): number {
  return Math.round(Date.parse(`${toCalendarDate(date)}T00:00:00Z`) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new RangeError("days must be an integer");
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days past due on `asOf` (<= 0 means not yet due); null without a due date. */
export function daysOverdue(dueDate: string | null, asOf: string): number | null {
  if (dueDate === null) return null;
  return dayNumber(asOf) - dayNumber(dueDate);
}

export function ageingBucket(dueDate: string | null, asOf: string): AgeingBucket {
  const days = daysOverdue(dueDate, asOf);
  if (days === null) return "no_due_date";
  if (days <= 0) return "not_due";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

/**
 * The open balance in the division currency, or null when not known. A stored `open_dc_minor` is
 * used when its currency is the division currency (or not stated). An item already in the division
 * currency needs no conversion, so its own open balance is the DC amount, but only once the
 * division currency was actually read from Exact (`known`). Never an FX conversion.
 */
export function resolveDcMinor(
  item: {
    currency: string;
    openMinor: number;
    openDcMinor: number | null;
    dcCurrency: string | null;
  },
  division: { currency: string; known: boolean },
): number | null {
  if (
    item.openDcMinor !== null &&
    (item.dcCurrency === null || item.dcCurrency === division.currency)
  ) {
    return item.openDcMinor;
  }
  if (division.known && item.currency === division.currency) return item.openMinor;
  return null;
}

export interface AgeingItem {
  /** Stable grouping key of the relation (the Exact account id); "" when unknown. */
  relationKey: string;
  relationName: string | null;
  currency: string;
  /** Open balance in the item currency, integer minor units (credit notes are negative). */
  openMinor: number;
  dueDate: string | null;
  /** Open balance in the division currency when known (see resolveDcMinor). */
  dcMinor: number | null;
}

export type BucketAmounts = Record<AgeingBucket, number>;

/** Sum of amounts in the division currency; `complete` is false when an item had none. */
export interface DcTotal {
  minor: number;
  complete: boolean;
}

export interface AgeingRow {
  relationKey: string;
  relationName: string | null;
  count: number;
  totalMinor: number;
  buckets: BucketAmounts;
  /** Item counts per bucket, so a cell can be checked against its drill-down. */
  bucketCounts: BucketAmounts;
  dc: DcTotal;
}

export interface AgeingTotals {
  currency: string;
  count: number;
  totalMinor: number;
  buckets: BucketAmounts;
  bucketCounts: BucketAmounts;
  dc: DcTotal;
}

export interface AgeingReport {
  asOf: string;
  /** One block per currency, ordered by currency code. */
  currencies: { currency: string; rows: AgeingRow[]; totals: AgeingTotals }[];
  totalsByCurrency: AgeingTotals[];
}

const zeroBuckets = (): BucketAmounts => ({
  not_due: 0,
  d1_30: 0,
  d31_60: 0,
  d61_90: 0,
  d90_plus: 0,
  no_due_date: 0,
});

const add = (a: number, b: number, currency: string): number =>
  addMoney(money(a, currency), money(b, currency)).minor;

interface Acc {
  count: number;
  totalMinor: number;
  buckets: BucketAmounts;
  bucketCounts: BucketAmounts;
  dcMinor: number;
  dcComplete: boolean;
}

const newAcc = (): Acc => ({
  count: 0,
  totalMinor: 0,
  buckets: zeroBuckets(),
  bucketCounts: zeroBuckets(),
  dcMinor: 0,
  dcComplete: true,
});

function accumulate(
  acc: Acc,
  currency: string,
  bucket: AgeingBucket,
  openMinor: number,
  dcMinor: number | null,
): void {
  acc.count += 1;
  acc.totalMinor = add(acc.totalMinor, openMinor, currency);
  acc.buckets[bucket] = add(acc.buckets[bucket], openMinor, currency);
  acc.bucketCounts[bucket] += 1;
  if (dcMinor === null) acc.dcComplete = false;
  else acc.dcMinor = add(acc.dcMinor, dcMinor, currency);
}

interface CurrencyAcc {
  total: Acc;
  rows: Map<string, { row: Acc; name: string | null }>;
}

/**
 * Aggregate open balances per relation and bucket, per currency. Rows are sorted largest
 * outstanding first (then name, then key, so the order is stable). `options.currency` limits the
 * report to one currency.
 */
export function buildAgeing(
  items: readonly AgeingItem[],
  asOfIso: string,
  options: { currency?: string } = {},
): AgeingReport {
  const asOf = toCalendarDate(asOfIso);
  const byCurrency = new Map<string, CurrencyAcc>();
  for (const item of items) {
    if (options.currency !== undefined && item.currency !== options.currency) continue;
    const bucket = ageingBucket(item.dueDate, asOf);
    let cur = byCurrency.get(item.currency);
    if (!cur) {
      cur = { total: newAcc(), rows: new Map() };
      byCurrency.set(item.currency, cur);
    }
    let rel = cur.rows.get(item.relationKey);
    if (!rel) {
      rel = { row: newAcc(), name: item.relationName };
      cur.rows.set(item.relationKey, rel);
    } else if (rel.name === null) {
      rel.name = item.relationName;
    }
    accumulate(rel.row, item.currency, bucket, item.openMinor, item.dcMinor);
    accumulate(cur.total, item.currency, bucket, item.openMinor, item.dcMinor);
  }

  const totalsOf = (currency: string, a: Acc): AgeingTotals => ({
    currency,
    count: a.count,
    totalMinor: a.totalMinor,
    buckets: a.buckets,
    bucketCounts: a.bucketCounts,
    dc: { minor: a.dcMinor, complete: a.dcComplete },
  });

  const currencies = [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([currency, cur]) => {
      const rows: AgeingRow[] = [...cur.rows.entries()].map(([relationKey, { row, name }]) => ({
        relationKey,
        relationName: name,
        count: row.count,
        totalMinor: row.totalMinor,
        buckets: row.buckets,
        bucketCounts: row.bucketCounts,
        dc: { minor: row.dcMinor, complete: row.dcComplete },
      }));
      rows.sort(
        (a, b) =>
          b.totalMinor - a.totalMinor ||
          (a.relationName ?? "").localeCompare(b.relationName ?? "", "en") ||
          (a.relationKey < b.relationKey ? -1 : a.relationKey > b.relationKey ? 1 : 0),
      );
      return { currency, rows, totals: totalsOf(currency, cur.total) };
    });
  return { asOf, currencies, totalsByCurrency: currencies.map((c) => c.totals) };
}
