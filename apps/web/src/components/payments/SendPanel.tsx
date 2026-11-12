import { useEffect, useRef, useState } from "react";
import type { BatchDto, PaymentDto } from "@camelthorn/core";
import { Button } from "@camelthorn/ui";
import { ApiError, type Me } from "../../api";
import { submitRequest } from "../../api-payments";
import {
  SEND_NEXT_TEXT,
  SEND_RESULT_TEXT,
  SEND_UNSURE_TEXT,
  FINAL_REFUSALS,
  describeSendError,
  isRefusal,
  rejectedReasonText,
  sendResultKey,
} from "../../lib/payment-send-labels";
import { NO_VALUE } from "../../lib/format";
import { useAction } from "../../lib/useAction";
import { StepUpNotice } from "../matching/MatchParts";
import { Money } from "../Money";

type RequestDto = PaymentDto | BatchDto;

/**
 * What the last Send to bank said. `final` ends the Send button for this opening of the sheet: a
 * handled request has moved on, and after an answer we could not read the request may already be
 * with the bank, so nobody may send it again from here.
 */
export type SendNote =
  | { kind: "result"; text: string; good: boolean; final: true }
  | { kind: "unsure"; text: string; final: true }
  | { kind: "refused"; text: string; final: boolean };

const MODE_WORDS = { drafts: "Draft in the Revolut app", pay: "One-click pay" } as const;

/**
 * Send to bank (F9c, ADR 0054) for an approved request that has not been sent. A button opens a
 * confirmation that restates what will be sent (supplier, masked bank account, amount, reference,
 * mode) and what happens next; the click on the button of that confirmation sends, once. Success
 * is reported only when the server's own answer says so. The server enforces everything again:
 * finance role, fresh Google sign-in, the switches, the approvals, the pre-checks, a claim that
 * makes a second send impossible.
 */
export function SendPanel({
  dto,
  me,
  onNote,
  onDone,
  onRefresh,
  onDirty,
}: {
  dto: RequestDto;
  me: Me;
  onNote: (n: SendNote | null) => void;
  onDone: (dto: RequestDto) => void;
  onRefresh: () => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const openerRow = useRef<HTMLDivElement>(null);
  // One decision, one call: set when the call starts, cleared only by a refusal (nothing was sent).
  const used = useRef(false);
  const { state, run } = useAction(describeSendError);
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  useEffect(() => onDirty?.(false), [onDirty]);

  async function go() {
    if (used.current) return;
    used.current = true;
    onNote(null);
    const r = await run(() => submitRequest(dto.kind, dto.id));
    if (r === null) return;
    if (r.ok) {
      const v = r.value as {
        result?: { to?: string; code?: string };
        payment?: PaymentDto;
        batch?: BatchDto;
      };
      const next = v.payment ?? v.batch ?? null;
      // The mode the SERVER sent it in (its answer), else the one it showed us: never guessed.
      const mode =
        next !== null && (next.mode === "drafts" || next.mode === "pay") ? next.mode : dto.mode;
      const key = typeof v.result?.to === "string" ? sendResultKey(v.result.to, mode) : null;
      if (key === null) {
        // The server's answer is not one we know how to read: say nothing good, send nothing again.
        onNote({ kind: "unsure", text: SEND_UNSURE_TEXT, final: true });
      } else {
        const reason =
          key === "rejected" && typeof v.result?.code === "string"
            ? ` ${rejectedReasonText(v.result.code)}`
            : "";
        onNote({
          kind: "result",
          text: `${SEND_RESULT_TEXT[key]}${reason}`,
          good: key === "submitted_drafts" || key === "submitted_pay",
          final: true,
        });
      }
      setOpen(false);
      if (next !== null) onDone(next);
      else onRefresh();
      return;
    }
    if (isRefusal(r.error)) {
      // Refused before anything was claimed: nothing was sent from here. A later attempt is
      // allowed, except when somebody else already holds the request (`already_claimed`).
      const final = FINAL_REFUSALS.has(r.error.code);
      if (!final) used.current = false;
      setOpen(false);
      onNote({ kind: "refused", text: describeSendError(r.error), final });
      onRefresh();
      return;
    }
    if (r.error instanceof ApiError && r.error.status === 401) {
      // No fresh sign-in: the server did nothing (useAction shows the sign-in button).
      used.current = false;
      return;
    }
    // No readable answer: it may have reached the bank. The button stays gone.
    setOpen(false);
    onNote({ kind: "unsure", text: SEND_UNSURE_TEXT, final: true });
    onRefresh();
  }

  if (!open) {
    return (
      <div className="pay-send">
        <div className="stack-row" ref={openerRow}>
          <Button
            variant="primary"
            onClick={() => {
              onNote(null);
              setOpen(true);
            }}
          >
            Send to bank
          </Button>
        </div>
        <p className="cap">
          Approved, but nothing has been sent yet. Sending asks you to confirm first.
        </p>
      </div>
    );
  }
  return (
    <section
      className="pay-send pay-send-confirm"
      aria-labelledby={`pay-send-h-${dto.kind}-${dto.id}`}
    >
      <h3 className="h3" id={`pay-send-h-${dto.kind}-${dto.id}`} tabIndex={-1} ref={heading}>
        Send to the bank
      </h3>
      <dl className="dl pay-dl" aria-label="What will be sent">
        {dto.kind === "payment" ? (
          <>
            <div className="dl-row">
              <dt>Supplier</dt>
              <dd>{dto.supplierName}</dd>
            </div>
            <div className="dl-row">
              <dt>Bank account</dt>
              <dd className="pay-iban">{dto.ibanMasked}</dd>
            </div>
            <div className="dl-row">
              <dt>Amount</dt>
              <dd>
                <Money minor={dto.amountMinor} currency={dto.currency} />
              </dd>
            </div>
            <div className="dl-row">
              <dt>Reference</dt>
              <dd>{dto.reference}</dd>
            </div>
          </>
        ) : (
          <>
            <div className="dl-row">
              <dt>Total</dt>
              <dd>
                <Money minor={dto.totalMinor} currency={dto.currency} />
                <span className="cap"> for {dto.itemCount} bills</span>
              </dd>
            </div>
          </>
        )}
        <div className="dl-row">
          <dt>Pay from</dt>
          <dd>{dto.sourceAccountName || NO_VALUE}</dd>
        </div>
        <div className="dl-row">
          <dt>Mode</dt>
          <dd>{MODE_WORDS[dto.mode]}</dd>
        </div>
      </dl>
      {dto.kind === "batch" && (
        <ul className="pay-list" aria-label="Bills in this batch">
          {dto.items.map((i) => (
            <li key={i.id}>
              {i.supplierName} · <span className="pay-iban">{i.ibanMasked}</span> · {i.reference} ·{" "}
              <Money minor={i.amountMinor} currency={i.currency} />
            </li>
          ))}
        </ul>
      )}
      <p className="notice" data-testid="send-next">
        {SEND_NEXT_TEXT[dto.mode]}
      </p>
      {!me.stepUpFresh && <StepUpNotice />}
      {state.needsStepUp && me.stepUpFresh && <StepUpNotice />}
      <div className="stack-row">
        <Button
          variant="primary"
          disabled={state.busy || !me.stepUpFresh}
          onClick={() => void go()}
        >
          {state.busy
            ? "Sending"
            : dto.mode === "drafts"
              ? "Create the draft in Revolut"
              : "Pay now"}
        </Button>
        <Button
          disabled={state.busy}
          onClick={() => {
            setOpen(false);
            setTimeout(() => openerRow.current?.querySelector("button")?.focus(), 0);
          }}
        >
          Back
        </Button>
      </div>
      <p className="cap">Do not close this page while it is sending.</p>
    </section>
  );
}
