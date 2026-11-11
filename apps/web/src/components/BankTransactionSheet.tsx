import type { ReactNode } from "react";
import type { BankTransactionDetail } from "@camelthorn/core";
import { Skeleton } from "@camelthorn/ui";
import { getBankTransaction } from "../api";
import { describeBankError } from "../lib/bank";
import { NO_VALUE, formatDateTime } from "../lib/format";
import { useResource } from "../lib/useResource";
import {
  BankAmount,
  MaskedIban,
  STATE_LABEL,
  StateChip,
  maskIban,
  normaliseState,
  stateNote,
} from "./BankParts";
import { DrillSheet } from "./DrillSheet";
import { FxAmount } from "./FxAmount";
import { ErrorNotice } from "./EmptyState";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dl-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Where we first heard of the transaction, in plain words. */
export function sourceLabel(source: string | null): string {
  switch (source) {
    case "webhook":
      return "Revolut notified us (webhook)";
    case "poll":
      return "Regular sync";
    case "backfill":
      return "Nightly catch-up";
    default:
      return "Not recorded";
  }
}

function Body({ detail }: { detail: BankTransactionDetail }) {
  const note = stateNote(detail);
  const iban = maskIban(detail.counterpartyIbanMasked);
  const legs = detail.legs;
  return (
    <div className="detail">
      <p className="lede">
        <BankAmount minor={detail.amountMinor} currency={detail.currency} state={detail.state} />{" "}
        <StateChip state={detail.state} />
      </p>
      <FxAmount
        currency={detail.currency}
        minor={detail.amountMinor}
        showOriginal={false}
        note="Today's rate, not the rate on the day."
      />
      {note && (
        <p className="notice warn" role="status">
          {note}
        </p>
      )}
      <dl className="dl">
        <Row label="Counterparty">{detail.counterpartyName ?? NO_VALUE}</Row>
        <Row label="Counterparty account">{iban ? <MaskedIban value={iban} /> : NO_VALUE}</Row>
        <Row label="Reference">
          {detail.reference ? <span className="copyable">{detail.reference}</span> : NO_VALUE}
        </Row>
        <Row label="Description">{detail.description ?? NO_VALUE}</Row>
        <Row label="Our account">{detail.accountName ?? NO_VALUE}</Row>
        <Row label="Type">{detail.type ?? NO_VALUE}</Row>
        <Row label="Status">
          {STATE_LABEL[normaliseState(detail.state)]}
          {detail.isFinal ? ", final" : ", not final"}
        </Row>
        <Row label="Created">{formatDateTime(detail.createdAt)}</Row>
        <Row label="Completed">{formatDateTime(detail.completedAt)}</Row>
        <Row label="First seen">{formatDateTime(detail.firstSeenAt)}</Row>
        <Row label="Last update from Revolut">{formatDateTime(detail.lastEventAt)}</Row>
        <Row label="Learned about through">{sourceLabel(detail.source)}</Row>
        <Row label="Revolut transaction id">
          <span className="copyable num">{detail.externalId}</span>
        </Row>
      </dl>
      {legs.length > 1 && (
        <section aria-labelledby="legs-h">
          <h3 id="legs-h" className="h3">
            {legs.length} legs
          </h3>
          <table className="tbl stacked">
            <caption className="sr-only">Legs of this transaction</caption>
            <thead>
              <tr>
                <th scope="col">Leg</th>
                <th scope="col">Account</th>
                <th scope="col">Status</th>
                <th scope="col" className="r">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {legs.map((l, i) => (
                <tr key={l.id} className={l.id === detail.id ? "sel" : undefined}>
                  <td>
                    <span className="cell-label" aria-hidden="true">
                      Leg
                    </span>
                    {i + 1} of {legs.length}
                    {l.id === detail.id && <span className="cap"> (this one)</span>}
                  </td>
                  <td>
                    <span className="cell-label" aria-hidden="true">
                      Account
                    </span>
                    {l.accountName ?? NO_VALUE}
                  </td>
                  <td>
                    <span className="cell-label" aria-hidden="true">
                      Status
                    </span>
                    <StateChip state={l.state} />
                  </td>
                  <td className="r">
                    <span className="cell-label" aria-hidden="true">
                      Amount
                    </span>
                    <BankAmount minor={l.amountMinor} currency={l.currency} state={l.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function SheetContent({ id }: { id: number }) {
  const res = useResource(`bank-tx:${id}`, (signal) => getBankTransaction(id, signal));
  if (res.status === "error") {
    return <ErrorNotice message={describeBankError(res.error)} onRetry={res.reload} />;
  }
  if (res.status !== "ready" || !res.data) {
    return (
      <div aria-busy="true">
        <Skeleton height={20} width="60%" />
        <Skeleton height={14} width="90%" />
        <Skeleton height={14} width="80%" />
        <p role="status" className="sr-only">
          Loading
        </p>
      </div>
    );
  }
  return <Body detail={res.data} />;
}

/** Sheet with one bank transaction: every field, its legs, no full account numbers. */
export function BankTransactionSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  return (
    <DrillSheet
      open={id !== null}
      title="Transaction details"
      onClose={onClose}
      viewKey={String(id)}
    >
      {id !== null && <SheetContent id={id} />}
    </DrillSheet>
  );
}
