import type { ReactNode } from "react";
import { Chip } from "@camelthorn/ui";
import { useFxRates } from "../fx";
import { formatDayMonth, formatMoney } from "../lib/format";
import {
  differenceOf,
  differenceSentence,
  missingRates,
  rateDateFor,
  rateText,
  rateUnitText,
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

/** Amber chip for rates that are old or missing; nothing when they are fresh. */
export function FxStaleChip() {
  const fx = useFxRates();
  const text = fx.data ? staleChipText(fx.data) : null;
  if (!text) return null;
  return <Chip tone="warn">{text}</Chip>;
}

/**
 * A foreign-currency figure in the administration's terms (CLAUDE.md 4.5): the original amount,
 * what it is worth at today's ECB rate, and, when Exact's booked amount is known, the unrealised
 * difference. Renders nothing while rates have not loaded, and nothing for an amount that is
 * already in the administration currency.
 *
 *  - rate missing: "No ECB rate for GBP" (not an error)
 *  - booked unknown: "Booked amount not known yet" (never 0)
 *  - `compact` leaves out the stale chip (a page shows it once)
 *
 * Everything shown is an estimate at today's rate, never the rate on the day and never booked.
 */
export function FxAmount({
  currency,
  minor,
  booked,
  showOriginal = true,
  compact = false,
  note,
  count,
}: {
  currency: string;
  minor: number | bigint;
  booked?: BookedAmount;
  /** Show the original amount first (leave off where it is already the big number). */
  showOriginal?: boolean;
  compact?: boolean;
  /** Extra caveat line, for example "Today's rate, not the rate on the day." */
  note?: ReactNode;
  /** Number of items behind the figure; 0 renders nothing. */
  count?: number;
}) {
  const fx = useFxRates();
  const { table, base } = fx;
  if (count !== undefined && count <= 0) return null;
  const original = showOriginal ? (
    <p className="fx-orig">
      <Money minor={minor} currency={currency} />
    </p>
  ) : null;
  if (currency === base) return original;
  if (!table) return original;

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
        <p className="cap fx-line fx-missing">No ECB rate for {currency}</p>
      </div>
    );
  }
  const date = rateDateFor(table, [currency, base]);
  const rate = rateText(table, currency, base);
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
        about <span className="num">{formatMoney(today.minor, base)}</span> at today&apos;s ECB rate
        {rate && (
          <>
            {" "}
            ({rate}
            <span className="sr-only">{rateUnitText(currency, base)}</span>
            {date ? `, ${formatDayMonth(date)}` : ""})
          </>
        )}
      </p>
      {note && <p className="cap fx-line">{note}</p>}
      {booked && diff && !diff.ok && diff.reason === "booked_unknown" && (
        <p className="cap fx-line">
          Booked amount not known yet
          {booked.minor > 0 && ` (at least ${formatMoney(booked.minor, base)} booked so far)`}
        </p>
      )}
      {booked && diff && diff.ok && (
        <>
          <p className="cap fx-line">
            Booked <span className="num">{formatMoney(diff.bookedMinor, base)}</span> · difference{" "}
            <span className="num">{signedMoney(diff.differenceMinor, base)}</span>
          </p>
          <p className="cap fx-line">
            {differenceSentence(booked.kind, minor, diff.differenceMinor, base)}{" "}
            {diff.differenceMinor === 0n ? "" : `(${resultWord(diff.resultMinor)})`}
          </p>
        </>
      )}
      {!compact && <FxStaleChip />}
    </div>
  );
}

/**
 * For the Overview and the ageing reports: the FxAmount lines under a figure once rates are
 * there, the plain "Exact's own amount" line (DcLine) until then, so nothing is lost when the
 * rates cannot be read.
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
  if (!fx.table || fx.base !== dcCurrency) {
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
  if (currency === dcCurrency || count <= 0) return null;
  return (
    <FxAmount
      currency={currency}
      minor={minor}
      booked={{ minor: dcMinor, complete: dcComplete, kind }}
      showOriginal={false}
      compact
    />
  );
}

/** One compact line under a row's amount: "about € 90,00" for a foreign-currency row. */
export function FxRowLine({ currency, minor }: { currency: string; minor: number | bigint }) {
  const { table, base } = useFxRates();
  if (!table || currency === base) return null;
  const missing = missingRates(table, currency, base);
  if (missing.length > 0) {
    return <span className="cap fx-row">No ECB rate for {missing.join(" and ")}</span>;
  }
  const c = toBase(table, minor, currency, base);
  if (!c.ok) return null;
  return (
    <span className="cap fx-row">
      about <span className="num">{formatMoney(c.minor, base)}</span>
      <span className="sr-only"> at today&apos;s ECB rate</span>
    </span>
  );
}
