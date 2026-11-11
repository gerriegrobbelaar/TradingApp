/**
 * Pure FX helpers for the screens (ADR 0035, 0037). Everything is BigInt on integer minor units and
 * the core decimal-string functions; there is no floating point here. Rates come from the API as
 * decimal strings ("units of the currency per 1 EUR") and conversion goes through the EUR cross
 * rate, so a USD amount in a GBP administration is converted USD -> GBP in one step with one
 * rounding.
 *
 * What is shown is an ESTIMATE at today's ECB rate (for information only). It is never booked and
 * never replaces the amount Exact holds.
 */
import {
  AGEING_BUCKETS,
  convertMinor,
  crossRate,
  formatRateForDisplay,
  parseDecimal,
  unrealisedDifference,
  unrealisedResultMinor,
  type AgeingBucket,
  type AgeingReportResponse,
  type FxRatesResponse,
  type RateTable,
} from "@camelthorn/core";
import { NO_VALUE, formatDayMonth, formatMoney } from "./format";

/** Fall-back administration currency when none is known (and the screen says so). */
export const FALLBACK_BASE = "EUR";

/** The rate table of an API response; null while there is no response. */
export function buildRateTable(resp: FxRatesResponse | null): RateTable | null {
  if (!resp) return null;
  const rates: Record<string, string> = {};
  const ratesDate: Record<string, string> = {};
  for (const r of resp.rates) {
    rates[r.currency] = r.rate;
    ratesDate[r.currency] = r.rateDate;
  }
  return { asOf: resp.asOf ?? "", base: "EUR", rates, ratesDate };
}

/** "€" for EUR, else the ISO code: the short name of the base currency in headings. */
export function baseLabel(base: string): string {
  return base === "EUR" ? "€" : base;
}

/** Currencies (of `currency` and `base`) that have no ECB rate in the table. EUR needs none. */
export function missingRates(table: RateTable, currency: string, base: string): string[] {
  const out: string[] = [];
  for (const code of [currency, base]) {
    if (code === "EUR" || out.includes(code)) continue;
    if (!Object.prototype.hasOwnProperty.call(table.rates, code)) out.push(code);
  }
  return out;
}

/**
 * The date of the rate an estimate rests on: the OLDEST date among the non-EUR currencies
 * involved (a cross rate is only as fresh as its older leg). Null when only EUR is involved.
 */
export function rateDateFor(table: RateTable, currencies: readonly string[]): string | null {
  let oldest: string | null = null;
  for (const code of currencies) {
    if (code === "EUR") continue;
    const d = table.ratesDate?.[code] ?? table.asOf;
    if (d && (oldest === null || d < oldest)) oldest = d;
  }
  return oldest;
}

export type Converted =
  { ok: true; minor: bigint; rate: string } | { ok: false; reason: "missing_rate" | "invalid" };

/** One conversion, one rounding (core `convertMinor`). */
export function toBase(
  table: RateTable,
  minor: number | bigint,
  currency: string,
  base: string,
): Converted {
  const r = convertMinor({ amountMinor: minor, from: currency, to: base, table });
  if (r.ok) return { ok: true, minor: r.amountMinor, rate: r.rateUsed };
  return { ok: false, reason: r.error === "missing_rate" ? "missing_rate" : "invalid" };
}

/**
 * The rate as people read it. With EUR as the administration currency that is the ECB's own
 * number ("1.0853", units of the currency per euro); otherwise the cross rate from the item's
 * currency into the administration currency ("1 USD = 0.79 GBP").
 */
export function rateText(table: RateTable, currency: string, base: string): string | null {
  if (base === "EUR") {
    const raw = table.rates[currency];
    return raw === undefined ? null : `rate ${formatRateForDisplay(raw)}`;
  }
  const x = crossRate(currency, base, table);
  return x === null ? null : `1 ${currency} = ${formatRateForDisplay(x)} ${base}`;
}

/** Spoken form of `rateText` for the EUR case: what the number is a number of. */
export function rateUnitText(currency: string, base: string): string {
  return base === "EUR" ? ` ${currency} per EUR` : "";
}

export interface ConvertedTotal {
  /** Sum of the per-currency converted totals (base-currency amounts are added as they are). */
  totalMinor: bigint;
  /** Currencies included (the base currency counts when it has an amount). */
  included: string[];
  /** Currencies left out because the table has no rate for them. */
  excluded: string[];
  /** Oldest rate date among the converted currencies; null when nothing needed a rate. */
  rateDate: string | null;
  /** True when at least one non-base currency was converted into the total. */
  converted: boolean;
}

/**
 * Total in the administration currency of amounts in several currencies. Amounts of one currency
 * are added first (exact integers), then each currency is converted ONCE (one rounding per
 * currency) and the converted totals are added. Raw amounts of different currencies are never
 * added. A currency without a rate is listed in `excluded` and contributes nothing.
 */
export function sumInBase(
  table: RateTable,
  base: string,
  parts: readonly { currency: string; minor: number | bigint }[],
): ConvertedTotal {
  const perCurrency = new Map<string, bigint>();
  for (const p of parts) {
    perCurrency.set(p.currency, (perCurrency.get(p.currency) ?? 0n) + BigInt(p.minor));
  }
  let total = 0n;
  const included: string[] = [];
  const excluded: string[] = [];
  const usedForDate: string[] = [];
  let converted = false;
  for (const [currency, minor] of perCurrency) {
    if (currency === base) {
      total += minor;
      included.push(currency);
      continue;
    }
    const c = toBase(table, minor, currency, base);
    if (!c.ok) {
      excluded.push(currency);
      continue;
    }
    total += c.minor;
    included.push(currency);
    usedForDate.push(currency);
    converted = true;
  }
  if (converted && base !== "EUR") usedForDate.push(base);
  return {
    totalMinor: total,
    included,
    excluded,
    rateDate: rateDateFor(table, usedForDate),
    converted,
  };
}

export interface AgeingFxTotals {
  base: string;
  /** One converted total per ageing bucket, and the overall total. */
  cells: Record<AgeingBucket | "total", ConvertedTotal>;
  /** Items per bucket over all currencies (a bucket without items shows a dash, not 0,00). */
  counts: Record<AgeingBucket | "total", number>;
  /** Currencies without a rate (the same in every cell) and the oldest rate date used. */
  excluded: string[];
  rateDate: string | null;
}

/**
 * The "Total in base at today's ECB rates" row of an ageing report: for each bucket, every
 * currency's bucket total is converted once and the converted totals are added (the same rule as
 * the Overview). Null when every currency is already the base currency (nothing to convert).
 */
export function ageingTotalsInBase(
  table: RateTable,
  base: string,
  currencies: AgeingReportResponse["currencies"],
): AgeingFxTotals | null {
  if (!currencies.some((c) => c.currency !== base)) return null;
  const cells = {} as Record<AgeingBucket | "total", ConvertedTotal>;
  const counts = {} as Record<AgeingBucket | "total", number>;
  counts.total = currencies.reduce((n, c) => n + c.totals.count, 0);
  for (const b of AGEING_BUCKETS) {
    counts[b] = currencies.reduce((n, c) => n + c.totals.bucketCounts[b], 0);
    cells[b] = sumInBase(
      table,
      base,
      currencies.map((c) => ({ currency: c.currency, minor: c.totals.buckets[b] })),
    );
  }
  cells.total = sumInBase(
    table,
    base,
    currencies.map((c) => ({ currency: c.currency, minor: c.totals.totalMinor })),
  );
  return { base, cells, counts, excluded: cells.total.excluded, rateDate: cells.total.rateDate };
}

export type Difference =
  | { ok: false; reason: "missing_rate" | "booked_unknown" | "invalid" }
  | {
      ok: true;
      todayMinor: bigint;
      bookedMinor: bigint;
      /** Today's value minus the booked amount, in base minor units (ADR 0035: not a gain/loss sign). */
      differenceMinor: bigint;
      /** Gain (positive) or loss (negative) by item kind, the core rule. */
      resultMinor: bigint;
      impliedBookedRate: string | null;
    };

/**
 * Unrealised difference of an open amount against what Exact booked. `bookedMinor` null = not
 * known (never treated as 0). Signs follow open_items (ADR 0022): a credit note is negative.
 */
export function differenceOf(
  table: RateTable,
  args: {
    kind: "invoice" | "bill";
    openMinor: number | bigint;
    currency: string;
    bookedMinor: number | bigint | null;
    base: string;
  },
): Difference {
  const r = unrealisedDifference({
    openMinor: args.openMinor,
    currency: args.currency,
    bookedBaseMinor: args.bookedMinor,
    baseCurrency: args.base,
    table,
  });
  if (!r.ok) {
    return {
      ok: false,
      reason:
        r.error === "missing_rate"
          ? "missing_rate"
          : r.error === "booked_unknown"
            ? "booked_unknown"
            : "invalid",
    };
  }
  return {
    ok: true,
    todayMinor: r.todayBaseMinor,
    bookedMinor: r.bookedBaseMinor,
    differenceMinor: r.differenceMinor,
    resultMinor: unrealisedResultMinor(args.kind, r.differenceMinor),
    impliedBookedRate: r.impliedBookedRate,
  };
}

/** "+€ 2,00", "-€ 2,00" or "€ 0,00": the signed figure of a difference. */
export function signedMoney(minor: bigint, currency: string): string {
  return minor > 0n ? `+${formatMoney(minor, currency)}` : formatMoney(minor, currency);
}

/**
 * The difference in words, by who owes whom. A receivable (customer invoice) is money you
 * receive, a payable (supplier bill) is money you pay. A credit note reverses the direction: a
 * sales credit note is money you refund, a purchase credit note is money you get back.
 * `openMinor` < 0 is a credit note. The amount in the sentence is the size of the difference.
 */
export function differenceSentence(
  kind: "invoice" | "bill",
  openMinor: number | bigint,
  differenceMinor: bigint,
  base: string,
): string {
  if (differenceMinor === 0n) return "No difference from the booked amount.";
  const size = formatMoney(differenceMinor < 0n ? -differenceMinor : differenceMinor, base);
  const credit = openMinor < 0;
  // A credit note has a negative amount, so a larger value in the base currency (difference > 0)
  // means a SMALLER refund: the words flip with the sign of the amount.
  const more = differenceMinor > 0n !== credit ? "more" : "less";
  if (kind === "invoice") {
    return credit
      ? `You would refund ${size} ${more} than booked.`
      : `You would receive ${size} ${more} than booked.`;
  }
  return credit
    ? `You would get back ${size} ${more} than booked.`
    : `You would pay ${size} ${more} than booked.`;
}

/** Gain or loss word for a result; text so it never depends on colour. */
export function resultWord(resultMinor: bigint): string {
  if (resultMinor > 0n) return "unrealised gain";
  if (resultMinor < 0n) return "unrealised loss";
  return "no unrealised result";
}

/** "one working day old", "3 working days old". */
function workingDaysText(n: number | null): string {
  if (n === null) return "older than one working day";
  if (n === 1) return "one working day old";
  return `${n} working days old`;
}

/** The text of the amber chip for a stale or empty feed; null when the rates are fresh. */
export function staleChipText(resp: FxRatesResponse): string | null {
  if (resp.staleReason === "never_imported") return "No ECB rates imported yet";
  if (!resp.stale) return null;
  const from = formatDayMonth(resp.asOf);
  return `Rates from ${from === NO_VALUE ? "an unknown date" : from}, ${workingDaysText(resp.workingDaysOld)}`;
}

// ---- charts: integer geometry ---------------------------------------------------------------------

/** A rate as an integer number of 10^-12 units, or null when it is not a plain decimal. */
export function scaledRate(rate: string): bigint | null {
  const d = parseDecimal(rate);
  if (!d || d.int < 0n || d.scale > 12) return null;
  return d.int * 10n ** BigInt(12 - d.scale);
}

export interface ChartPoint {
  rateDate: string;
  rate: string;
  /** Integer plot coordinates (BigInt: no float anywhere). */
  x: bigint;
  y: bigint;
}

export interface ChartGeometry {
  points: ChartPoint[];
  min: string;
  max: string;
  first: ChartPoint | null;
  last: ChartPoint | null;
  lowest: ChartPoint | null;
  highest: ChartPoint | null;
  /** SVG path data, "M x y L x y ...". */
  path: string;
}

/**
 * Pixel positions for a single-series line chart, by integer (BigInt) division: x spreads the
 * points evenly (the series is a list of ECB publication days), y maps the rate between its
 * lowest and highest value onto the plot height (high at the top). A flat series sits in the
 * middle. Rows with a rate that is not a plain decimal are dropped.
 */
export function chartGeometry(
  series: readonly { rateDate: string; rate: string }[],
  plot: { width: number; height: number },
): ChartGeometry {
  const rows: { rateDate: string; rate: string; v: bigint }[] = [];
  for (const p of series) {
    const v = scaledRate(p.rate);
    if (v !== null) rows.push({ ...p, v });
  }
  if (rows.length === 0) {
    return {
      points: [],
      min: "",
      max: "",
      first: null,
      last: null,
      lowest: null,
      highest: null,
      path: "",
    };
  }
  let lo = rows[0]!;
  let hi = rows[0]!;
  for (const r of rows) {
    if (r.v < lo.v) lo = r;
    if (r.v > hi.v) hi = r;
  }
  const span = hi.v - lo.v;
  const w = BigInt(plot.width);
  const h = BigInt(plot.height);
  const n = BigInt(rows.length);
  const points: ChartPoint[] = rows.map((r, i) => {
    const xi = n === 1n ? w / 2n : (BigInt(i) * w) / (n - 1n);
    const yi = span === 0n ? h / 2n : h - ((r.v - lo.v) * h) / span;
    return { rateDate: r.rateDate, rate: r.rate, x: xi, y: yi };
  });
  const at = (r: { rateDate: string }) => points.find((p) => p.rateDate === r.rateDate) ?? null;
  return {
    points,
    min: lo.rate,
    max: hi.rate,
    first: points[0] ?? null,
    last: points[points.length - 1] ?? null,
    lowest: at(lo),
    highest: at(hi),
    path: points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" "),
  };
}
