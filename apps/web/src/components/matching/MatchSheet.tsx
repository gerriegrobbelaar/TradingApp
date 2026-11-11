import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { BookingSettingsResponse, MatchDetailResponse, MatchDto } from "@camelthorn/core";
import { Button, Chip, Skeleton } from "@camelthorn/ui";
import { getBookingSettings, getMatchDetail } from "../../api-matching";
import { useToast } from "../../toasts";
import { NO_VALUE, formatDateTime, formatMoney } from "../../lib/format";
import {
  STATE_CONFLICT_BADGE,
  STATE_CONFLICT_TEXT,
  describeMatchError,
  exactStateLabel,
  ignoreReasonLabel,
  reviewReasonLabel,
} from "../../lib/matching-labels";
import { clearConflict, unignoreTransaction } from "../../api-matching";
import { isStale } from "../../lib/matching-labels";
import { useAction } from "../../lib/useAction";
import { useResource } from "../../lib/useResource";
import { BankAmount, MaskedIban, maskIban } from "../BankParts";
import { DrillSheet } from "../DrillSheet";
import { ErrorNotice } from "../EmptyState";
import { CandidateCard } from "./CandidateCard";
import { MatchChooser } from "./MatchChooser";
import { ErrorLine, StepUpNotice, useMatchRole } from "./MatchParts";
import { UndoPanel } from "./UndoPanel";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dl-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const SOURCE_LABEL: Record<MatchDto["source"], string> = {
  auto: "Matched automatically",
  manual: "Matched by a person",
  ledger: "Booked to a ledger account by a person",
};

/** The match a line has now: what it settles, who made it, whether Exact has it, and Undo. */
export function MatchedPanel({
  match,
  currency,
  canAct,
  onDone,
  onStale,
}: {
  match: MatchDto;
  currency: string;
  canAct: boolean;
  onDone: () => void;
  onStale: () => void;
}) {
  const review = reviewReasonLabel(match.reviewReason);
  return (
    <section className="mt-matched" aria-labelledby="mt-matched-h">
      <h3 id="mt-matched-h" className="h3">
        Matched
      </h3>
      {review && (
        <p role="status" className="notice warn">
          <Chip tone="warn">Needs a check</Chip> {review}. It is never booked in Exact until a
          person has undone and redone it.
        </p>
      )}
      <dl className="dl">
        <Row label="How">{SOURCE_LABEL[match.source]}</Row>
        <Row label="By">{match.createdBy}</Row>
        <Row label="When">{formatDateTime(match.createdAt)}</Row>
        {match.score !== null && <Row label="Score">{match.score}</Row>}
        {match.ledgerAccountCode && <Row label="Ledger account">{match.ledgerAccountCode}</Row>}
        <Row label="In Exact">{exactStateLabel(match.exactState)}</Row>
        {match.note && <Row label="Note">{match.note}</Row>}
      </dl>
      {match.allocations.length > 0 && (
        <ul className="mt-cand-allocs" aria-label="Invoices settled">
          {match.allocations.map((a) => (
            <li key={a.openItemId}>
              {formatMoney(a.allocatedMinor, a.currency || currency)} to{" "}
              {a.invoiceNumber ?? `item ${a.openItemId}`}
              {a.relationName ? ` (${a.relationName})` : ""}
              {a.remainingMinorAfter !== null && a.remainingMinorAfter !== 0 && (
                <span className="cap">
                  {" "}
                  · {formatMoney(a.remainingMinorAfter, a.currency || currency)} stays open
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <UndoPanel match={match} canAct={canAct} onDone={onDone} onStale={onStale} />
    </section>
  );
}

function ConflictPanel({
  txId,
  isAdmin,
  onDone,
  onStale,
}: {
  txId: number;
  isAdmin: boolean;
  onDone: () => void;
  onStale: () => void;
}) {
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const { state, run } = useAction();
  async function clear() {
    const r = await run(() => clearConflict(txId, { note: note.trim() }));
    if (r?.ok) onDone();
    else if (r && isStale(r.error)) onStale();
  }
  return (
    <section className="mt-conflict" aria-labelledby="mt-conflict-h">
      <h3 id="mt-conflict-h" className="h3">
        <Chip tone="warn">{STATE_CONFLICT_BADGE}</Chip>
      </h3>
      <p role="note" className="notice warn">
        {STATE_CONFLICT_TEXT}
      </p>
      {isAdmin ? (
        !confirming ? (
          <>
            <label className="field">
              What did you check? (required)
              <input
                className="input"
                value={note}
                maxLength={200}
                autoComplete="off"
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <div>
              <Button disabled={note.trim() === ""} onClick={() => setConfirming(true)}>
                Clear conflict…
              </Button>
            </div>
          </>
        ) : (
          <div className="mt-confirm" role="group" aria-label="Confirm clearing the conflict">
            <p>
              Clear the conflict? The line can be matched again. Only do this after checking the
              payment in Revolut. Your note: {note.trim()}
            </p>
            {state.needsStepUp && <StepUpNotice />}
            {state.error && <ErrorLine>{state.error}</ErrorLine>}
            <div className="stack-row">
              <Button variant="primary" disabled={state.busy} onClick={() => void clear()}>
                Clear the conflict
              </Button>
              <Button disabled={state.busy} onClick={() => setConfirming(false)}>
                Back
              </Button>
            </div>
          </div>
        )
      ) : (
        <p className="cap">Ask an administrator to check this line.</p>
      )}
    </section>
  );
}

function IgnoredPanel({
  detail,
  canAct,
  onDone,
  onStale,
}: {
  detail: MatchDetailResponse;
  canAct: boolean;
  onDone: () => void;
  onStale: () => void;
}) {
  const ig = detail.transaction.ignore;
  const { state, run } = useAction();
  async function unignore() {
    const r = await run(() => unignoreTransaction(detail.transaction.id));
    if (r?.ok) onDone();
    else if (r && isStale(r.error)) onStale();
  }
  return (
    <section className="mt-ignored" aria-labelledby="mt-ignored-h">
      <h3 id="mt-ignored-h" className="h3">
        Ignored
      </h3>
      <p>
        {ignoreReasonLabel(ig?.reason)}
        {ig?.note ? `. ${ig.note}` : ""}
      </p>
      {ig && (
        <p className="cap">
          By {ig.by || NO_VALUE} on {formatDateTime(ig.at)}
        </p>
      )}
      {canAct && (
        <>
          {state.needsStepUp && <StepUpNotice />}
          {state.error && <ErrorLine>{state.error}</ErrorLine>}
          <div>
            <Button disabled={state.busy} onClick={() => void unignore()}>
              Unignore
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function TxSummary({ detail }: { detail: MatchDetailResponse }) {
  const tx = detail.transaction;
  const iban = maskIban(tx.counterpartyIbanMasked);
  return (
    <div className="detail">
      <p className="lede">
        <BankAmount minor={tx.amountMinor} currency={tx.currency} state="completed" />
      </p>
      <dl className="dl">
        <Row label="Date">{formatDateTime(tx.completedAt ?? tx.createdAt)}</Row>
        <Row label="Counterparty">{tx.counterpartyName ?? NO_VALUE}</Row>
        <Row label="Counterparty account">{iban ? <MaskedIban value={iban} /> : NO_VALUE}</Row>
        <Row label="Reference">{tx.reference ?? NO_VALUE}</Row>
        <Row label="Description">{tx.description ?? NO_VALUE}</Row>
        <Row label="Our account">{tx.accountName ?? NO_VALUE}</Row>
        <Row label="Type">{tx.type ?? NO_VALUE}</Row>
      </dl>
    </div>
  );
}

function Loading() {
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

function Body({
  id,
  onChanged,
  onClose,
}: {
  id: number;
  /** Something changed on the server: refetch the queue and the counts. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const { canAct, isAdmin } = useMatchRole();
  const [notice, setNotice] = useState<string | null>(null);
  const res = useResource<MatchDetailResponse>(`match-detail:${id}`, (signal) =>
    getMatchDetail(id, signal),
  );
  // The booking setting only changes the wording; if it cannot be read the wording stays neutral.
  const bookingRes = useResource<BookingSettingsResponse | null>(
    canAct ? "booking-settings" : null,
    (signal) =>
      getBookingSettings(signal).catch((e: unknown) => {
        if (signal.aborted) throw e;
        return null;
      }),
  );
  const booking = bookingRes.data;

  const done = (message: string) => {
    toast.show(message);
    onChanged();
    onClose();
  };
  const stale = (message: string) => {
    setNotice(message);
    onChanged();
    res.reload();
  };

  if (res.status === "error") {
    return <ErrorNotice message={describeMatchError(res.error)} onRetry={res.reload} />;
  }
  if (res.status !== "ready" || !res.data || (canAct && bookingRes.status === "loading")) {
    return <Loading />;
  }
  const detail = res.data;
  const tx = detail.transaction;
  const match = detail.match;

  return (
    <div className="mt-sheet">
      {notice && (
        <p role="alert" className="notice warn">
          {notice}
        </p>
      )}
      <TxSummary detail={detail} />
      {match && (
        <MatchedPanel
          match={match}
          currency={tx.currency}
          canAct={canAct}
          onDone={() => done("Undid the match. The line is back in the review list.")}
          onStale={() =>
            stale("This match changed in the meantime. The sheet shows the latest state.")
          }
        />
      )}
      {!match && tx.matchStatus === "ignored" && (
        <IgnoredPanel
          detail={detail}
          canAct={canAct}
          onDone={() => done("Unignored. The line is back in the review list.")}
          onStale={() =>
            stale("This line changed in the meantime. The sheet shows the latest state.")
          }
        />
      )}
      {!match && tx.stateConflict && (
        <ConflictPanel
          txId={tx.id}
          isAdmin={isAdmin}
          onDone={() => done("Cleared the conflict. The line can be matched again.")}
          onStale={() =>
            stale("This line changed in the meantime. The sheet shows the latest state.")
          }
        />
      )}
      {!match && !tx.mapped && (
        <p role="note" className="notice warn">
          <Chip tone="warn">Not matched until mapped</Chip> This bank account is not linked to an
          administration yet, so nothing can be matched.{" "}
          {isAdmin ? (
            <Link to="/settings/matching">Map it in Settings, Matching</Link>
          ) : (
            "Ask an administrator to map it."
          )}
        </p>
      )}
      {!match && tx.matchStatus !== "ignored" && !tx.stateConflict && tx.mapped && (
        <MatchChooser
          detail={detail}
          booking={booking}
          canAct={canAct}
          onDone={done}
          onStale={stale}
        />
      )}
      {!match && (tx.stateConflict || !tx.mapped) && detail.candidates.length > 0 && (
        <section aria-labelledby="mt-ro-cands">
          <h3 id="mt-ro-cands" className="h3">
            What the engine suggested
          </h3>
          {detail.candidates.slice(0, 5).map((c) => (
            <CandidateCard key={c.rank} c={c} currency={tx.currency} />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * The match sheet: one bank line with its candidates and the ways to settle it. Read-only for
 * viewers. Nothing is booked in Exact from here; every change is confirmed first and recorded in
 * the app, and the server validates again (ADR 0043).
 */
export function MatchSheet({
  id,
  onClose,
  onChanged,
}: {
  id: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <DrillSheet open={id !== null} title="Match bank line" onClose={onClose} viewKey={String(id)}>
      {id !== null && <Body key={id} id={id} onChanged={onChanged} onClose={onClose} />}
    </DrillSheet>
  );
}
