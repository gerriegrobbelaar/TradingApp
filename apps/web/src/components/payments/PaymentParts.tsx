import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  batchConfirmPhrase,
  paymentConfirmPhrase,
  phraseMatches,
  type BankAccountDto,
  type BatchDto,
  type PaymentDto,
  type PaymentEventDto,
  type PaymentStatus,
} from "@camelthorn/core";
import { Button, Chip, formatAgo } from "@camelthorn/ui";
import { cancelRequest, confirmRequest, decideRequest } from "../../api-payments";
import type { Me } from "../../api";
import {
  APPROVAL_REASON_FALLBACK,
  CANCEL_FINAL_TEXT,
  DRAFTS_MODE_TEXT,
  OUTCOME_UNKNOWN_TEXT,
  approvalReasonText,
  displayStatus,
  isBooked,
  subjectOf,
  blockText,
  blocksOf,
  describePaymentError,
  eventText,
  itemBlocksOf,
  reasonText,
  warningText,
} from "../../lib/payment-labels";
import { SendPanel, type SendNote } from "./SendPanel";
import { formatDateTime, formatEcbRate, NO_VALUE } from "../../lib/format";
import { useAction } from "../../lib/useAction";
import { ConfirmButton, ErrorLine, StepUpNotice } from "../matching/MatchParts";
import { Money } from "../Money";

export type RequestDto = PaymentDto | BatchDto;

export const sameUser = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export const hasRole = (me: Me, role: string): boolean => (me.roles as string[]).includes(role);

const IN_FLIGHT: readonly PaymentStatus[] = ["ready", "submitting", "submitted"];
const CANCELLABLE: readonly PaymentStatus[] = ["draft", "pending_approval", "ready"];
const FINAL: readonly PaymentStatus[] = ["failed", "rejected", "cancelled", "expired"];

/**
 * Nothing more will change. A request the bank paid is NOT final until the payment is booked in
 * Exact (CLAUDE.md 4.3), so its screen keeps checking.
 */
export const isFinalRequest = (dto: RequestDto): boolean =>
  FINAL.includes(dto.status) || isBooked(dto.status, subjectOf(dto).settlement);

/** The first 12 characters of the payload hash: enough to compare two screens, not the whole 64. */
export const shortHash = (h: string): string => h.slice(0, 12);

// ---- small pieces -----------------------------------------------------------------------------

/** The one status chip: "Paid" only when the bank confirmed AND the payment is booked in Exact. */
export function StatusChip({ dto }: { dto: RequestDto }) {
  const t = displayStatus(subjectOf(dto));
  return <Chip tone={t.tone}>{t.label}</Chip>;
}

/** Why a request is blocked: what is wrong and what to do, one list item per code, never blank. */
export function BlockList({
  codes,
  itemBlocks,
  labelFor,
}: {
  codes: readonly string[];
  itemBlocks?: readonly { openItemId: number; blocks: readonly string[] }[];
  labelFor?: (openItemId: number) => string;
}) {
  const unique = [...new Set(codes)];
  return (
    <div role="alert" className="notice warn pay-blocks">
      <p className="pay-blocks-title">This payment cannot be requested yet.</p>
      <ul className="pay-list">
        {unique.map((c) => {
          const t = blockText(c);
          return (
            <li key={c}>
              <span>{t.what}</span> <span className="pay-todo">{t.todo}</span>
            </li>
          );
        })}
      </ul>
      {itemBlocks && itemBlocks.length > 0 && (
        <ul className="pay-list">
          {itemBlocks.map((ib) => (
            <li key={ib.openItemId}>
              <strong>{labelFor ? labelFor(ib.openItemId) : `Bill ${ib.openItemId}`}</strong>
              <ul className="pay-list">
                {[...new Set(ib.blocks)].map((c) => {
                  const t = blockText(c);
                  return (
                    <li key={c}>
                      <span>{t.what}</span> <span className="pay-todo">{t.todo}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Warnings({ codes }: { codes: readonly string[] }) {
  if (codes.length === 0) return null;
  return (
    <ul className="pay-list pay-warnings" aria-label="Things to check">
      {[...new Set(codes)].map((c) => (
        <li key={c}>
          <Chip tone="gold">Check</Chip> {warningText(c)}
        </li>
      ))}
    </ul>
  );
}

/** The source account with its last known balance and how old that balance is. */
export function BalanceLine({
  account,
  nowMs,
  needMinor,
}: {
  account: BankAccountDto | null;
  nowMs?: number;
  needMinor?: number | bigint;
}) {
  if (account === null) return <span className="muted">{NO_VALUE}</span>;
  const at = account.balanceAt === null ? NaN : Date.parse(account.balanceAt);
  if (account.balanceMinor === null || !Number.isFinite(at)) {
    return <span>Balance not known</span>;
  }
  const low = needMinor !== undefined && BigInt(account.balanceMinor) < BigInt(needMinor);
  return (
    <span>
      Last known balance <Money minor={account.balanceMinor} currency={account.currency} />, read{" "}
      {formatAgo(nowMs ?? Date.now(), at)}
      {low && <strong className="pay-low"> That is less than this payment.</strong>}
    </span>
  );
}

function ApprovalNote({ dto }: { dto: RequestDto }) {
  if (dto.approvalsRequired.length === 0) {
    return <p className="cap">No second person is needed for this payment.</p>;
  }
  return (
    <div className="notice pay-approval">
      <p>A second person (an approver) must approve this before it is sent:</p>
      <ul className="pay-list">
        {dto.approvalsRequired.map((r) => (
          <li key={r}>{approvalReasonText(r) || APPROVAL_REASON_FALLBACK}</li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dl-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function EurLine({
  p,
}: {
  p: { currency: string; eurMinor: number | null; eurRate?: string | null };
}) {
  if (p.currency === "EUR" || p.eurMinor === null) return null;
  return (
    <span className="cap">
      {" "}
      About <Money minor={p.eurMinor} currency="EUR" /> at the ECB rate
      {p.eurRate ? ` of ${formatEcbRate(p.eurRate)}` : ""}
    </span>
  );
}

export function IbanCell({ p }: { p: PaymentDto }) {
  return (
    <span>
      <span className="pay-iban">{p.ibanMasked}</span>{" "}
      <Chip tone="ok">Verified by an approver</Chip>
      {p.approvalsRequired.includes("new_or_changed_iban") && (
        <>
          {" "}
          <Chip tone="gold">First payment to these details</Chip>
        </>
      )}
      <span className="cap pay-fp"> Fingerprint {p.ibanFingerprintShort.slice(0, 8)}</span>
    </span>
  );
}

// ---- what will be paid ------------------------------------------------------------------------

export function PaymentSummary({
  dto,
  account,
}: {
  dto: PaymentDto;
  account: BankAccountDto | null;
}) {
  return (
    <dl className="dl pay-dl">
      <Row label="Supplier">{dto.supplierName}</Row>
      <Row label="Bank account">
        <IbanCell p={dto} />
      </Row>
      <Row label="Amount">
        <Money minor={dto.amountMinor} currency={dto.currency} />
        <EurLine p={dto} />
      </Row>
      <Row label="Bill">
        {dto.invoiceNumber ?? NO_VALUE}
        {dto.dueDate ? ` · due ${dto.dueDate}` : ""}
      </Row>
      <Row label="Reference">{dto.reference}</Row>
      <Row label="Pay from">
        <span>{dto.sourceAccountName || NO_VALUE}</span>
        <br />
        <BalanceLine account={account} needMinor={dto.amountMinor} />
      </Row>
    </dl>
  );
}

export function BatchSummary({ dto, account }: { dto: BatchDto; account: BankAccountDto | null }) {
  return (
    <>
      <dl className="dl pay-dl">
        <Row label="Total">
          <Money minor={dto.totalMinor} currency={dto.currency} />
          <EurLine p={{ currency: dto.currency, eurMinor: dto.eurMinor }} />
          <span className="cap"> for {dto.itemCount} bills</span>
        </Row>
        <Row label="Pay from">
          <span>{dto.sourceAccountName || NO_VALUE}</span>
          <br />
          <BalanceLine account={account} needMinor={dto.totalMinor} />
        </Row>
      </dl>
      <div className="scroll">
        <table className="tbl stacked pay-items">
          <caption className="sr-only">Bills in this batch</caption>
          <thead>
            <tr>
              <th scope="col">Bill</th>
              <th scope="col">Supplier</th>
              <th scope="col">Bank account</th>
              <th scope="col">Reference</th>
              <th scope="col" className="r">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {dto.items.map((i) => (
              <tr key={i.id}>
                <td>{i.invoiceNumber ?? NO_VALUE}</td>
                <td>{i.supplierName}</td>
                <td>
                  <span className="pay-iban">{i.ibanMasked}</span>
                </td>
                <td>{i.reference}</td>
                <td className="r">
                  <Money minor={i.amountMinor} currency={i.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- status and history -----------------------------------------------------------------------

export function StatusPanel({ dto }: { dto: RequestDto }) {
  const t = displayStatus(subjectOf(dto));
  const why = reasonText(dto.statusReason);
  const sent = dto.status === "submitting" || dto.status === "submitted";
  return (
    <div className="pay-status" role="status">
      <p>
        <StatusChip dto={dto} /> <span>{t.meaning}</span>
      </p>
      {t.step !== null && <p className="cap">{t.step}</p>}
      {dto.status === "outcome_unknown" && (
        <p role="alert" className="notice warn">
          {OUTCOME_UNKNOWN_TEXT}
        </p>
      )}
      {(dto.status === "failed" || dto.status === "rejected") && why && (
        <p className={dto.statusReason === "draft_expired" ? "notice warn" : "cap"}>{why}</p>
      )}
      {dto.mode === "drafts" && sent && dto.status === "submitting" && (
        <p className="cap">{DRAFTS_MODE_TEXT}</p>
      )}
      {dto.decision && (
        <p className="cap">
          {dto.decision.decision === "approved" ? "Approved" : "Turned down"} by {dto.decision.by}{" "}
          on {formatDateTime(dto.decision.at)}.
          {dto.decision.note ? ` Note: ${dto.decision.note}` : ""}
        </p>
      )}
      {(dto.status === "draft" || dto.status === "pending_approval" || dto.status === "ready") && (
        <p className="cap">Valid until {formatDateTime(dto.expiresAt)}.</p>
      )}
    </div>
  );
}

export function Timeline({ events }: { events: readonly PaymentEventDto[] }) {
  if (events.length === 0) return <p className="cap">No history was recorded yet.</p>;
  return (
    <ol className="pay-timeline" aria-label="History">
      {events.map((e, i) => (
        <li key={`${e.at}:${i}`}>
          <span className="pay-tl-what">{eventText(e.code, e.toStatus)}</span>
          <span className="cap">
            {" "}
            · {e.actor === "system" ? "automatically" : e.actor} · {formatDateTime(e.at)}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---- confirmation (typed phrase) --------------------------------------------------------------

/** The phrase the sheet expects, recomputed here from the amounts it shows. */
export function expectedPhrase(dto: RequestDto): string {
  return dto.kind === "payment"
    ? paymentConfirmPhrase(dto.amountMinor, dto.currency, dto.ibanMasked.slice(-4))
    : batchConfirmPhrase(dto.itemCount, dto.totalMinor, dto.currency);
}

const resultOf = (r: unknown): RequestDto | null => {
  const o = r as { payment?: PaymentDto; batch?: BatchDto } | null;
  return o?.payment ?? o?.batch ?? null;
};

/**
 * Confirms a draft: the person types the phrase shown above the field (never pre-filled; pasting
 * is allowed; compared exactly, case-sensitive, not trimmed). The phrase the server sent must equal
 * the one recomputed from the amounts on screen, otherwise the sheet refuses to go on. One
 * request at a time (double click = one request); a missing fresh sign-in shows the sign-in button.
 */
export function ConfirmPanel({
  dto,
  stepUpFresh,
  onDone,
  onDirty,
  onFailed,
}: {
  dto: RequestDto;
  stepUpFresh: boolean;
  onDone: (dto: RequestDto) => void;
  onDirty?: (dirty: boolean) => void;
  /** After a refusal, so the caller can re-read what is behind it. */
  onFailed?: () => void;
}) {
  const phrase = expectedPhrase(dto);
  const serverOk = dto.confirmPhrase === phrase;
  const [typed, setTyped] = useState("");
  const [blocks, setBlocks] = useState<{
    codes: string[];
    items: { openItemId: number; blocks: readonly string[] }[];
  } | null>(null);
  const { state, run } = useAction(describePaymentError);
  useEffect(() => onDirty?.(typed !== ""), [typed, onDirty]);
  const needsApproval = dto.approvalsRequired.length > 0;
  const ready = serverOk && phraseMatches(typed, phrase) && stepUpFresh && !state.busy;

  async function go() {
    setBlocks(null);
    const r = await run(() => confirmRequest(dto.kind, dto.id, typed));
    if (r === null) return;
    if (r.ok) {
      const next = resultOf(r.value);
      if (next) onDone(next);
      return;
    }
    const codes = blocksOf(r.error);
    if (codes) setBlocks({ codes, items: itemBlocksOf(r.error) });
    onFailed?.();
  }

  if (!serverOk) {
    return (
      <p role="alert" className="notice warn">
        The confirmation text from the server does not match the amount shown here, so this cannot
        be confirmed. Close the sheet and open it again. Nothing was paid.
      </p>
    );
  }
  return (
    <div className="pay-confirm">
      <p id={`pay-phrase-label-${dto.kind}-${dto.id}`}>
        To confirm, type this text exactly as it appears:
      </p>
      <p>
        <code className="pay-phrase" data-testid="pay-phrase">
          {phrase}
        </code>
      </p>
      <label className="field">
        Confirmation text
        <input
          className="input"
          value={typed}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={`pay-phrase-label-${dto.kind}-${dto.id}`}
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>
      {!stepUpFresh && <StepUpNotice />}
      {state.needsStepUp && stepUpFresh && <StepUpNotice />}
      {blocks && <BlockList codes={blocks.codes} itemBlocks={blocks.items} />}
      {state.error && !blocks && <ErrorLine>{state.error}</ErrorLine>}
      <div className="stack-row">
        <Button variant="primary" disabled={!ready} onClick={() => void go()}>
          {needsApproval ? "Confirm and ask for approval" : "Confirm payment"}
        </Button>
      </div>
      <p className="cap">
        {needsApproval
          ? "Nothing is sent to the bank until an approver has approved it."
          : "After you confirm, the payment is approved but not sent. Someone in finance must still use Send to bank. It shows as Paid only when the bank confirms it and it is booked in Exact."}
      </p>
    </div>
  );
}

// ---- approving --------------------------------------------------------------------------------

/**
 * What an approver sees and does. They approve exactly what is on screen: the payload hash the
 * screen holds is sent back, so a payment that changed in the meantime is refused (409
 * payload_changed) and the sheet re-reads it. Not offered on one's own request (and the server
 * refuses it too). Rejecting needs a reason.
 */
export function DecisionPanel({
  dto,
  me,
  onDone,
  onRefresh,
}: {
  dto: RequestDto;
  me: Me;
  onDone: (dto: RequestDto) => void;
  onRefresh: () => void;
}) {
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const { state, run } = useAction(describePaymentError);
  const [expiredNow, setExpiredNow] = useState(false);
  // The payload this person has read. A re-read (after a refusal, "Check status again" or the
  // quiet refresh) can bring another payload under the same buttons: then nothing can be decided
  // until the person says they have read the new one.
  const [seenHash, setSeenHash] = useState(dto.payloadHash);
  const changedUnderneath = seenHash !== dto.payloadHash;
  useEffect(() => {
    const t = Date.parse(dto.expiresAt);
    setExpiredNow(Number.isFinite(t) && t <= Date.now());
  }, [dto.expiresAt]);
  if (dto.status !== "pending_approval") return null;
  if (!hasRole(me, "approver")) {
    return <p className="cap">Only an approver can approve or turn down this payment.</p>;
  }
  if (sameUser(dto.requestedBy, me.email)) {
    return (
      <p className="notice" role="status">
        You requested this payment, so someone else must approve it.
      </p>
    );
  }
  if (expiredNow) {
    return (
      <p className="notice warn" role="status">
        This request is older than 24 hours and can no longer be approved. Nothing was paid.
      </p>
    );
  }
  const noteOk = !rejecting || note.trim().length >= 3;
  async function decide(decision: "approve" | "reject") {
    if (changedUnderneath) return;
    const r = await run(() =>
      decideRequest(
        dto.kind,
        dto.id,
        decision,
        dto.payloadHash,
        note.trim() === "" ? null : note.trim(),
      ),
    );
    if (r === null) return;
    if (r.ok) {
      const next = resultOf(r.value);
      if (next) onDone(next);
      return;
    }
    // The request changed, was decided, or expired meanwhile: show what it is now.
    onRefresh();
  }
  return (
    <div className="pay-decision">
      <p className="cap">
        Payload fingerprint <code>{shortHash(dto.payloadHash)}</code>. Your approval is only valid
        for exactly what is shown here.
      </p>
      {state.needsStepUp && <StepUpNotice />}
      {!me.stepUpFresh && !state.needsStepUp && <StepUpNotice />}
      {state.error && <ErrorLine>{state.error}</ErrorLine>}
      {changedUnderneath && (
        <div role="alert" className="notice warn" data-testid="pay-payload-changed">
          <p>
            This payment changed since you started reading it (fingerprint{" "}
            <code>{shortHash(seenHash)}</code> is now <code>{shortHash(dto.payloadHash)}</code>).
            Nothing was approved. Read everything above again before you decide.
          </p>
          <Button size="sm" onClick={() => setSeenHash(dto.payloadHash)}>
            I have read the new details
          </Button>
        </div>
      )}
      {rejecting && (
        <label className="field">
          Reason for turning this down
          <textarea
            className="input"
            rows={3}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      )}
      {!rejecting && (
        <label className="field">
          Note (optional)
          <input
            className="input"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      )}
      {rejecting && !noteOk && <p className="cap">Write at least 3 characters.</p>}
      <div className="stack-row">
        {!rejecting && (
          <Button
            variant="primary"
            disabled={state.busy || !me.stepUpFresh || changedUnderneath}
            onClick={() => void decide("approve")}
          >
            Approve payment
          </Button>
        )}
        {!rejecting ? (
          <Button disabled={state.busy} onClick={() => setRejecting(true)}>
            Turn down
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={state.busy || !noteOk || !me.stepUpFresh || changedUnderneath}
              onClick={() => void decide("reject")}
            >
              Turn down payment
            </Button>
            <Button disabled={state.busy} onClick={() => setRejecting(false)}>
              Back
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ---- cancelling -------------------------------------------------------------------------------

export function CancelPanel({
  dto,
  me,
  onDone,
  onFailed,
}: {
  dto: RequestDto;
  me: Me;
  onDone: (dto: RequestDto) => void;
  onFailed: () => void;
}) {
  const { state, run } = useAction(describePaymentError);
  const mine = sameUser(dto.requestedBy, me.email) && hasRole(me, "finance");
  const allowed = CANCELLABLE.includes(dto.status) && (mine || hasRole(me, "admin"));
  if (!allowed) return null;
  return (
    <div className="pay-cancel">
      <p className="cap">{CANCEL_FINAL_TEXT}</p>
      {state.error && <ErrorLine>{state.error}</ErrorLine>}
      <ConfirmButton
        label="Cancel this request"
        question="Cancel this request for good?"
        confirmLabel="Yes, cancel it"
        busy={state.busy}
        onConfirm={() => {
          void run(() => cancelRequest(dto.kind, dto.id, null)).then((r) => {
            if (r === null) return;
            if (r.ok) {
              const next = resultOf(r.value);
              if (next) onDone(next);
            } else onFailed();
          });
        }}
      />
    </div>
  );
}

// ---- one request, whole ----------------------------------------------------------------------

/**
 * Everything about one request in one place: what will be paid, where it stands, what the person
 * may do now (confirm a draft, approve, cancel) and its history. Used by the Pay sheet after the
 * draft exists, by the detail sheet in Treasury, Bank, Payments and by the approvals.
 */
export function RequestView({
  dto,
  events,
  me,
  account,
  warnings,
  onChanged,
  onRefresh,
  onDirty,
  showApprove = true,
}: {
  dto: RequestDto;
  events: readonly PaymentEventDto[] | null;
  me: Me;
  account: BankAccountDto | null;
  warnings?: readonly string[];
  onChanged: (dto: RequestDto) => void;
  onRefresh: () => void;
  onDirty?: (dirty: boolean) => void;
  showApprove?: boolean;
}) {
  // Requests on their way are re-read now and then; a final one is not.
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const inFlight =
    IN_FLIGHT.includes(dto.status) || dto.status === "pending_approval" || !isFinalRequest(dto);
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => refreshRef.current(), 15_000);
    return () => clearInterval(id);
  }, [inFlight]);
  const mine = sameUser(dto.requestedBy, me.email);
  // What the last Send to bank said; it outlives the panel, which goes when the status moves on.
  const [sendNote, setSendNote] = useState<SendNote | null>(null);
  // Focus follows the answer: the confirmation that held focus is gone, so the note takes it.
  const noteRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (sendNote !== null) noteRef.current?.focus();
  }, [sendNote]);
  return (
    <div className="pay-view">
      <p className="lede">
        {dto.kind === "payment" ? (
          <>
            <Money minor={dto.amountMinor} currency={dto.currency} /> to {dto.supplierName}
          </>
        ) : (
          <>
            <Money minor={dto.totalMinor} currency={dto.currency} /> to pay {dto.itemCount} bills
          </>
        )}
      </p>
      <StatusPanel dto={dto} />
      {sendNote !== null && (
        <p
          role={sendNote.kind === "result" ? "status" : "alert"}
          className={sendNote.kind === "result" && sendNote.good ? "notice" : "notice warn"}
          data-testid="send-result"
          tabIndex={-1}
          ref={noteRef}
        >
          {sendNote.text}
        </p>
      )}
      {dto.kind === "payment" ? (
        <PaymentSummary dto={dto} account={account} />
      ) : (
        <BatchSummary dto={dto} account={account} />
      )}
      {warnings && <Warnings codes={warnings} />}
      {(dto.status === "draft" || dto.status === "pending_approval") && <ApprovalNote dto={dto} />}
      <p className="cap">
        Requested by {mine ? "you" : dto.requestedBy} on {formatDateTime(dto.createdAt)}.
      </p>
      {dto.status === "draft" &&
        (mine && hasRole(me, "finance") ? (
          <ConfirmPanel
            // A changed payload is a new decision: what was typed for the old one is dropped.
            key={dto.payloadHash}
            dto={dto}
            stepUpFresh={me.stepUpFresh}
            onDone={onChanged}
            onFailed={onRefresh}
            {...(onDirty ? { onDirty } : {})}
          />
        ) : (
          <p className="cap">Only the person who prepared this can confirm it.</p>
        ))}
      {showApprove && <DecisionPanel dto={dto} me={me} onDone={onChanged} onRefresh={onRefresh} />}
      {dto.status === "ready" && hasRole(me, "finance") && (sendNote?.final ?? false) === false && (
        <SendPanel
          // A changed payload is a new decision: the confirmation of the old one is dropped.
          key={dto.payloadHash}
          dto={dto}
          me={me}
          onNote={setSendNote}
          onDone={onChanged}
          onRefresh={onRefresh}
          {...(onDirty ? { onDirty } : {})}
        />
      )}
      {!isFinalRequest(dto) && dto.status !== "draft" && (
        <div className="stack-row">
          <Button size="sm" onClick={onRefresh}>
            Check status again
          </Button>
        </div>
      )}
      <CancelPanel dto={dto} me={me} onDone={onChanged} onFailed={onRefresh} />
      {events && (
        <section>
          <h3 className="h3">History</h3>
          <Timeline events={events} />
        </section>
      )}
    </div>
  );
}
