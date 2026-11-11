import { Link } from "react-router";
import type { BankAccountDto, BankTransactionDto, BankTxState, Freshness } from "@camelthorn/core";
import { Chip, Stamp, formatAgo, type ChipTone } from "@camelthorn/ui";
import { useMe } from "../auth";
import { NO_VALUE, formatDateTime, formatMoney } from "../lib/format";

// ---- amounts -----------------------------------------------------------------------------------

/** U+2212, read as "minus" by screen readers; the hyphen-minus is not. */
const MINUS = "\u2212";

/**
 * Words announced before an amount. Only a COMPLETED transaction is "Received" or "Paid"; a pending
 * or unknown one is "Incoming" / "Outgoing" and not final; declined, failed and reverted ones say
 * that the money did not move (stayed moved). Exported for tests.
 */
export function amountWords(minor: number, state: string): string {
  const s = normaliseState(state);
  const inbound = minor > 0;
  switch (s) {
    case "completed":
      return inbound ? "Received" : "Paid";
    case "pending":
    case "unknown":
      return inbound ? "Incoming, not final" : "Outgoing, not final";
    case "reverted":
      return inbound ? "Incoming, reverted" : "Outgoing, reverted";
    case "declined":
    case "failed":
      return inbound ? "Incoming, did not go through" : "Outgoing, did not go through";
  }
}

/**
 * One transaction amount. The sign goes before the currency symbol ("+" in, minus sign out) and
 * the figure comes from formatMoney; the direction and state are announced in words (see
 * amountWords), so colour is a second signal only: completed money in is green, completed money
 * out and anything not final is ink, declined / failed / reverted is muted. Not the shared Money
 * component: its "credit" wording is for invoices and would read a payment out as a credit.
 */
export function BankAmount({
  minor,
  currency,
  state,
}: {
  minor: number;
  currency: string;
  state: string;
}) {
  if (minor === 0) return <span className="num money">{formatMoney(0, currency)}</span>;
  const text = formatMoney(Math.abs(minor), currency);
  if (text === NO_VALUE) return <span className="num money">{text}</span>;
  const s = normaliseState(state);
  const inbound = minor > 0;
  const tone =
    s === "completed"
      ? inbound
        ? "tx-in"
        : "tx-out"
      : s === "declined" || s === "failed" || s === "reverted"
        ? "tx-void"
        : "tx-out";
  return (
    <span className={`num money tx-amt ${tone}`}>
      <span className="sr-only">{amountWords(minor, s)} </span>
      {inbound ? "+" : MINUS}
      {text}
    </span>
  );
}

/** A total whose direction is known from the column it sits in; the magnitude is shown. */
export function BankTotal({
  minor,
  currency,
  direction,
}: {
  minor: number;
  currency: string;
  direction: "in" | "out";
}) {
  const text = formatMoney(Math.abs(minor), currency);
  const sign = minor === 0 || text === NO_VALUE ? "" : direction === "in" ? "+" : MINUS;
  return (
    <span className={`num money tx-amt ${direction === "in" ? "tx-in" : "tx-out"}`}>
      {sign}
      {text}
    </span>
  );
}

// ---- IBAN --------------------------------------------------------------------------------------

/**
 * "•••• 1234". Only the last four letters or digits are ever shown, whatever the server sent, so a
 * full IBAN cannot reach the page even if an answer carried one.
 */
export function maskIban(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const tail = raw
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-4)
    .toUpperCase();
  return tail ? `•••• ${tail}` : "••••";
}

/** The masked account number ("•••• 1234") with the dots hidden from screen readers. */
export function MaskedIban({ value }: { value: string }) {
  const tail = value.replace(/^•+\s?/, "");
  if (tail === "") return <span className="num">Account number hidden</span>;
  return (
    <span className="num">
      <span className="sr-only">Account number ending </span>
      <span aria-hidden="true">•••• </span>
      {tail}
    </span>
  );
}

// ---- state chips -------------------------------------------------------------------------------

export const STATE_LABEL: Record<BankTxState, string> = {
  pending: "Pending",
  completed: "Completed",
  declined: "Declined",
  failed: "Failed",
  reverted: "Reverted",
  unknown: "Unknown",
};

const STATE_TONE: Record<BankTxState, ChipTone> = {
  pending: "gold",
  completed: "ok",
  declined: "warn",
  failed: "warn",
  reverted: "gold",
  unknown: "neutral",
};

/** A state the screen does not know is shown as Unknown, never as completed. */
export function normaliseState(s: string): BankTxState {
  return Object.prototype.hasOwnProperty.call(STATE_LABEL, s) ? (s as BankTxState) : "unknown";
}

export const NOT_FINAL_NOTE = "Not final — not used for matching";
export const UNKNOWN_NOTE = "Status not recognised — not used for matching";
export const NOT_THROUGH_NOTE = "Did not go through — not counted in totals";
export const REVERTED_NOTE = "Reversed by Revolut — not counted in totals";

export function StateChip({ state }: { state: string }) {
  const s = normaliseState(state);
  return <Chip tone={STATE_TONE[s]}>{STATE_LABEL[s]}</Chip>;
}

/** The line about what the state means for matching; null when there is nothing to say. */
export function stateNote(tx: Pick<BankTransactionDto, "state" | "isFinal">): string | null {
  const s = normaliseState(tx.state);
  if (s === "unknown") return UNKNOWN_NOTE;
  if (s === "pending" || !tx.isFinal) return NOT_FINAL_NOTE;
  if (s === "declined" || s === "failed") return NOT_THROUGH_NOTE;
  if (s === "reverted") return REVERTED_NOTE;
  return null;
}

// ---- freshness ---------------------------------------------------------------------------------

/**
 * "Updated 5 min ago" for the bank data. Never synced and out of date are separate chips with an
 * honest sentence each. Not the Exact FreshnessStamp: its wording is about Exact.
 */
export function BankStamp({
  freshness,
  connected,
  now,
}: {
  freshness: Freshness | null;
  connected: boolean;
  now?: number;
}) {
  const auth = useMe();
  if (!freshness || !connected) return null;
  const admin = auth.status === "ready" && auth.me.roles.includes("admin");
  const at = freshness.lastCompletedAt ? Date.parse(freshness.lastCompletedAt) : null;
  const never = at === null || !Number.isFinite(at);
  const link = admin ? (
    <>
      {" "}
      <Link to="/settings/connections">Check connections</Link>
    </>
  ) : null;
  if (never) {
    return (
      <div className="freshness">
        <Chip tone="warn">Never synced</Chip>
        <p className="notice warn" role="status">
          Nothing has been read from Revolut yet.{link}
        </p>
      </div>
    );
  }
  return (
    <div className="freshness">
      <Stamp at={at} {...(now !== undefined ? { now } : {})} />
      {freshness.stale && (
        <>
          <Chip tone="warn">Out of date</Chip>
          <p className="notice warn" role="status">
            Bank data was last read {formatAgo(now ?? Date.now(), at)}, which is more than{" "}
            {freshness.staleAfterHours} hours ago. Balances and transactions may be behind Revolut.
            {link}
          </p>
        </>
      )}
    </div>
  );
}

// ---- account cards -----------------------------------------------------------------------------

export function AccountCard({
  account,
  selected,
  onToggle,
}: {
  account: BankAccountDto;
  selected: boolean;
  onToggle: () => void;
}) {
  const iban = maskIban(account.ibanMasked);
  return (
    <button
      type="button"
      className={["acct", account.isActive ? "" : "off", selected ? "sel" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-pressed={selected}
      onClick={onToggle}
    >
      <span className="acct-top">
        <span className="acct-name">{account.name}</span>
        <Chip>{account.currency}</Chip>
        {!account.isActive && <Chip>Inactive</Chip>}
      </span>
      <span className="acct-bal num">
        {account.balanceMinor === null
          ? "No balance yet"
          : formatMoney(account.balanceMinor, account.currency)}
      </span>
      <span className="cap">
        {account.balanceAt
          ? `Balance as of ${formatDateTime(account.balanceAt)}`
          : "Balance not read yet"}
      </span>
      {iban && (
        <span className="cap">
          <MaskedIban value={iban} />
        </span>
      )}
    </button>
  );
}
