import type { ReactNode } from "react";
import { Chip } from "@camelthorn/ui";
import { useFxRates } from "../fx";
import { formatDayMonth, formatMoney } from "../lib/format";
import {
  differenceOf,
  differenceSentence,
  hiddenNoticeText,
  isTodaysRate,
  missingRates,
  rateDateFor,
  rateText,
  rateUnitText,
  rateWording,
  resultWord,
  signedMoney,
  staleChipText,
  toBase,
} from "../lib/fx";
import { DcLine } from "./DcLine";
import { Money } from "./Money";

/** What Exact booked for the figure, in the administration currency. */
export interface BookedAmount {
  /** Booked base-currency minor units (the part Exact has, when not `complete`). */
  minor: number;
  /** False when some items have no booked amount: the booked amount is then not known. */
  complete: boolean;
  /** invoice = receivable, bill = payable (decides the wording, ADR 0035). */
  kind: "invoice" | "bill";
}

/**
 * Amber chip for rates that are old or missing; nothing when they are fresh. Rates past the
 * cut-off (review S7) get the notice that estimates are hidden instead.
 */
export function FxStaleChip() {
  const fx = useFxRates();
  const text = fx.data ? (hiddenNoticeText(fx.data) ?? staleChipText(fx.data)) : null;
  if (!text) return null;
  return <Chip tone="warn">{text}</Chip>;
}

/**
 * The stale-rates chip ONCE at the top of a page that shows foreign-currency figures (the
 * Invoices and Payables lists, the Overview, the ageing reports). `foreign` is false for a page
 * whose amounts are all in the administration currency: nothing is estimated there, so a warning
 * about the rates would only be noise.
 */
export function FxPageChip({ foreign }: { foreign: boolean }) {
  const fx = useFxRates();
  if (!foreign) return null;
  const text = fx.data ? (hiddenNoticeText(fx.data) ?? staleChipText(fx.data)) : null;
  if (!text) return null;
  return (
    <div className="fx-page-chip">
      <Chip tone="warn">{text}</Chip>
    </div>
  );
}

/**
 * Placeholder lines while the rates (or the administration currency) are still on their way:
 * the same line class and count as the lines that will replace them, so the page does not jump
 * when they arrive (ADR 0037). Hidden from assistive technology; the figure above stays readable.
 */
export function FxPendingLines({ lines }: { lines: number }) {
  return (
    <>
      {Array.from({ length: lines }, (_, i) => (
        <p key={i} className="cap fx-line fx-pending" aria-hidden="true" data-fx-pending="">
          <span className={i === 0 ? "sk fx-sk" : "sk fx-sk fx-sk-short"} />
        </p>
      ))}
    </>
  );
}

/** How many lines FxAmount will show under a figure (for the placeholder while loading). */
function expectedLines(booked: BookedAmount | undefined, note: boolean): number {
  return 1 + (note ? 1 : 0) + (booked ? (booked.complete ? 2 : 1) : 0);
}

/**
 * A foreign-currency figure in the administration's terms (CLAUDE.md 4.5): the original amount,
 * what it is worth at today's ECB rate, and, when Exact's booked amount is known, the unrealised
 * difference. While rates load it keeps the space of the lines to come; it renders nothing more
 * for an amount that is already in the administration currency, or when rates could not be read.
 *
 *  - rate missing: "No ECB rate for GBP" (not an error)
 *  - booked unknown: "Booked amount not known yet" (never 0)
 *  - `compact` leaves out the stale chip (a page shows it once)
 *  - `base`: the currency the booked amount is in (an item's own division currency). The
 *    conversion goes to that currency, so booked and today's value can never be in different
 *    currencies, even for a moment while the administration is being switched.
 *
 * Everything shown is an estimate at today's rate, never the rate on the day and never booked.
 */
export function FxAmount({
  currency,
  minor,
  booked,
  base: baseProp,
  showOriginal = true,
  compact = false,
  note,
  count,
  aggregate = false,
}: {
  currency: string;
  minor: number | bigint;
  booked?: BookedAmount;
  base?: string;
  /** Show the original amount first (leave off where it is already the big number). */
  showOriginal?: boolean;
  compact?: boolean;
  /** Extra caveat line, for example "Today's rate, not the rate on the day." */
  note?: ReactNode;
  /** Number of items behind the figure; 0 renders nothing. */
  count?: number;
  /**
   * The figure adds up many items (Overview, ageing): its difference is labelled an ESTIMATE, as
   * it will not equal the month-end journal, which is built from item-level differences.
   */
  aggregate?: boolean;
}) {
  const fx = useFxRates();
  const table = fx.table;
  const base = baseProp ?? fx.base;
  if (count !== undefined && count <= 0) return null;
  const original = showOriginal ? (
    <p className="fx-orig">
      <Money minor={minor} currency={currency} />
    </p>
  ) : null;
  if (currency === base) return original;
  if (fx.hidden) {
    // Rates past the cut-off: the original amount only, and why there is no estimate.
    return (
      <div className="fx-amount">
        {original}
        <p className="cap fx-line fx-missing">
          No estimate: the ECB rates are {fx.data?.workingDaysOld} working days old
        </p>
      </div>
    );
  }
  if (!fx.ready || !table) {
    if (!fx.pending) {
      if (fx.status !== "error") return original;
      return (
        <div className="fx-amount">
          {original}
          <p className="cap fx-line fx-missing">No estimate: the ECB rates could not be read</p>
        </div>
      );
    }
    return (
      <div className="fx-amount">
        {original}
        <FxPendingLines lines={expectedLines(booked, note !== undefined)} />
      </div>
    );
  }

  const missing = missingRates(table, currency, base);
  if (missing.length > 0) {
    return (
      <div className="fx-amount">
        {original}
        <p className="cap fx-line fx-missing">No ECB rate for {missing.join(" and ")}</p>
      </div>
    );
  }
  const today = toBase(table, minor, currency, base);
  if (!today.ok) {
    return (
      <div className="fx-amount">
        {original}
        <p className="cap fx-line fx-missing">
          {today.reason === "missing_rate"
            ? `No ECB rate for ${currency}`
            : "No estimate: the amount cannot be converted exactly"}
        </p>
      </div>
    );
  }
  const date = rateDateFor(table, [currency, base]);
  const rate = rateText(table, currency, base);
  const wording = rateWording(fx.data, date);
  const current = isTodaysRate(fx.data, date);
  const diff = booked
    ? differenceOf(table, {
        kind: booked.kind,
        openMinor: minor,
        currency,
        bookedMinor: booked.complete ? booked.minor : null,
        base,
      })
    : null;

  return (
    <div className="fx-amount">
      {original}
      <p className="cap fx-line">
        about <span className="num">{formatMoney(today.minor, base)}</span> {wording}
        {rate && (
          <>
            {" "}
            ({rate}
            <span className="sr-only">{rateUnitText(currency, base)}</span>
            {date && current ? `, ${formatDayMonth(date)}` : ""})
          </>
        )}
      </p>
      {note && <p className="cap fx-line">{note}</p>}
      {booked && diff && !diff.ok && diff.reason === "booked_unknown" && (
        <p className="cap fx-line">
          Booked amount not known yet
          {booked.minor !== 0 &&
            ` (${formatMoney(booked.minor, base)} booked for the items Exact has an amount for)`}
        </p>
      )}
      {booked && diff && !diff.ok && diff.reason !== "booked_unknown" && (
        <p className="cap fx-line fx-missing">
          No difference: the amounts cannot be compared exactly
        </p>
      )}
      {booked && diff && diff.ok && (
        <>
          <p className="cap fx-line">
            Booked <span className="num">{formatMoney(diff.bookedMinor, base)}</span> ·{" "}
            {aggregate ? "estimated difference" : "difference"}{" "}
            <span className="num">{signedMoney(diff.differenceMinor, base)}</span>
            {aggregate ? "" : ` ${wording}`}
          </p>
          <p className="cap fx-line">
            {differenceSentence(booked.kind, minor, diff.differenceMinor, base)}
            {diff.differenceMinor === 0n ? "" : ` (${resultWord(diff.resultMinor)})`}
          </p>
        </>
      )}
      {!compact && <FxStaleChip />}
    </div>
  );
}

/**
 * For the Overview and the ageing reports: the FxAmount lines under a figure once rates are
 * there, the plain "Exact's own amount" line (DcLine) when they cannot be read or the figure is
 * not in the selected administration's currency, and placeholder lines while they load (so the
 * card keeps its height).
 */
export function FxDcLine({
  currency,
  dcCurrency,
  dcMinor,
  dcComplete,
  count,
  minor,
  kind,
}: {
  currency: string;
  dcCurrency: string;
  dcMinor: number;
  dcComplete: boolean;
  count: number;
  /** Open amount of the figure in `currency`. */
  minor: number;
  kind: "invoice" | "bill";
}) {
  const fx = useFxRates();
  if (currency === dcCurrency || count <= 0) return null;
  if (fx.pending) {
    return (
      <div className="fx-amount">
        <FxPendingLines lines={expectedLines({ minor: 0, complete: dcComplete, kind }, false)} />
      </div>
    );
  }
  if (!fx.ready || fx.base !== dcCurrency) {
    return (
      <DcLine
        currency={currency}
        dcCurrency={dcCurrency}
        dcMinor={dcMinor}
        dcComplete={dcComplete}
        count={count}
      />
    );
  }
  return (
    <FxAmount
      currency={currency}
      minor={minor}
      base={dcCurrency}
      booked={{ minor: dcMinor, complete: dcComplete, kind }}
      showOriginal={false}
      compact
      aggregate
    />
  );
}

/** One compact line under a row's amount: "about € 90,00" for a foreign-currency row. */
export function FxRowLine({ currency, minor }: { currency: string; minor: number | bigint }) {
  const { table, base, ready, pending, data, hidden } = useFxRates();
  if (currency === base || hidden) return null;
  if (!ready || !table) {
    // Keep the row's height while the rates load, so the table does not jump.
    return pending ? (
      <span className="cap fx-row fx-pending" aria-hidden="true" data-fx-pending="">
        <span className="sk fx-sk fx-sk-short" />
      </span>
    ) : null;
  }
  const missing = missingRates(table, currency, base);
  if (missing.length > 0) {
    return <span className="cap fx-row">No ECB rate for {missing.join(" and ")}</span>;
  }
  const c = toBase(table, minor, currency, base);
  if (!c.ok) return null;
  // Fresh rates: "about € 90,00" (the wording is for screen readers). Stale rates: the date is
  // part of the visible line, "about € 90,00 at the ECB rate of 6 Nov" (review S7).
  const date = rateDateFor(table, [currency, base]);
  const todays = isTodaysRate(data, date);
  return (
    <span className="cap fx-row">
      about <span className="num">{formatMoney(c.minor, base)}</span>
      {todays ? (
        <span className="sr-only"> {rateWording(data, date)}</span>
      ) : (
        <> {rateWording(data, date)}</>
      )}
    </span>
  );
}
