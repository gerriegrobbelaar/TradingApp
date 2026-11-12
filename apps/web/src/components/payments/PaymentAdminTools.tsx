import { useState, type ReactNode } from "react";
import {
  PAYMENTS_ENABLE_PHRASE,
  PAYMENTS_RESOLVE_PHRASE,
  PAYMENTS_VERIFY_PHRASE,
  type BatchDto,
  type PaymentDto,
  type PaymentPreviewResponse,
  type PaymentsSettingsResponse,
} from "@camelthorn/core";
import { Button, Card, Chip, Skeleton, formatAgo } from "@camelthorn/ui";
import { ApiError } from "../../api";
import {
  listPaymentBatches,
  listPayments,
  previewPayment,
  resolveNotSent,
  setDraftExpiryDays,
  switchPaymentsOn,
  verifyPaymentPath,
  type SubjectKind,
} from "../../api-payments";
import { toSafeNumber } from "../../lib/allocation";
import { describeLoadError } from "../../lib/errors";
import { formatDateTime } from "../../lib/format";
import { blockerText, describePaymentError, verifyCheckText } from "../../lib/payment-labels";
import { useAction } from "../../lib/useAction";
import { useResource } from "../../lib/useResource";
import { useToast } from "../../toasts";
import { ErrorNotice } from "../EmptyState";
import { ErrorLine, StepUpNotice } from "../matching/MatchParts";
import { TypedPhraseSheet } from "../matching/TypedPhraseSheet";
import { Money } from "../Money";

/** Marked "unknown" for at least this long before an administrator may call it not sent (server rule). */
export const MIN_AGE_TEXT = "15 minutes";

/** The blockers list of a refused enable, in words; every other refusal in the shared words. */
export function describeEnableError(e: unknown): string {
  if (e instanceof ApiError && e.code === "blocked") {
    const list = e.lists?.["blockers"] ?? [];
    return list.length > 0
      ? `Something still stops payments: ${list.map((b) => blockerText(b).replace(/\.$/, "")).join("; ")}.`
      : "Something still stops payments from being switched on.";
  }
  return describePaymentError(e);
}

// ---- switching on -----------------------------------------------------------------------------

/**
 * The switch (admin). Switching OFF is in the main card. Switching ON needs a fresh sign-in, the
 * typed phrase, a verification of the current payment rules and no blockers; the server checks
 * every one of them again inside the write.
 */
export function EnableControls({
  data,
  onChanged,
}: {
  data: PaymentsSettingsResponse;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const blockers = data.blockers.filter((b) => b !== "payments_disabled");
  if (data.enabled) return null;
  return (
    <>
      <div className="stack-row">
        <Button variant="primary" disabled={blockers.length > 0} onClick={() => setOpen(true)}>
          Switch payments on
        </Button>
      </div>
      {blockers.length > 0 && (
        <p className="cap">
          Payments can be switched on when the points above are done. Recording a verification
          always leaves payments switched off.
        </p>
      )}
      <TypedPhraseSheet
        open={open}
        title="Switch payments on"
        intro={
          <>
            <p className="lede">
              After this, finance can send approved payments to the bank
              {data.settings.mode === "pay"
                ? ", and the bank pays at once."
                : ", as drafts that wait for approval in the Revolut app."}{" "}
              Real money can leave the company.
            </p>
            <p className="cap">Type the text below to confirm.</p>
          </>
        }
        phrase={PAYMENTS_ENABLE_PHRASE}
        confirmLabel="Switch payments on"
        note={{ label: "Why (optional)", required: false, maxLength: 200 }}
        describe={describeEnableError}
        onClose={() => setOpen(false)}
        onConfirm={({ phrase, note }) =>
          switchPaymentsOn({ confirm: phrase, ...(note !== "" ? { note } : {}) })
        }
        onDone={() => {
          setOpen(false);
          toast.show("Payments are switched on.");
          onChanged();
        }}
        onFailed={(e) => {
          if (e instanceof ApiError && e.code === "blocked") onChanged();
        }}
      />
    </>
  );
}

// ---- recording the verification ---------------------------------------------------------------

/**
 * The verification record. One tick box per check of the server's list (rendered from the list
 * itself, so a check added later shows up without a new release), each with its runbook steps.
 * The ticks live in this sheet only: nothing is stored in the browser, and closing it loses them
 * (the sheet asks first). The server needs the COMPLETE list, the typed phrase and a note.
 */
export function VerifyControls({
  data,
  onChanged,
}: {
  data: PaymentsSettingsResponse;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const all = data.verifyChecks;
  const complete = all.length > 0 && all.every((c) => ticked.has(c));
  return (
    <>
      <div className="stack-row">
        <Button onClick={() => setOpen(true)}>
          {data.verified ? "Record the verification again" : "Record the verification"}
        </Button>
      </div>
      <p className="cap">
        Do the checks on the Revolut sandbox first, then tick them here. Recording a verification
        leaves payments switched off.
      </p>
      <TypedPhraseSheet
        open={open}
        title="Record the payment verification"
        intro={
          <>
            <p className="lede">
              Tick a check only when you did it on the Revolut sandbox and it passed. All{" "}
              {all.length} must be ticked.
            </p>
            <p className="cap" data-testid="verify-progress">
              {ticked.size} of {all.length} ticked.
            </p>
          </>
        }
        extra={
          <ul className="pay-list pay-verify" aria-label="Verification checks">
            {all.map((c) => {
              const entry = data.verifyRunbook?.[c];
              return (
                <li key={c}>
                  <label className="check-inline">
                    <input
                      type="checkbox"
                      checked={ticked.has(c)}
                      onChange={(e) => {
                        const next = new Set(ticked);
                        if (e.target.checked) next.add(c);
                        else next.delete(c);
                        setTicked(next);
                      }}
                    />
                    <span>{entry?.title ?? verifyCheckText(c)}</span>
                  </label>
                  {entry && (
                    <details className="pay-runbook">
                      <summary>Steps for this check</summary>
                      <ol>
                        {entry.steps.map((st, i) => (
                          <li key={i}>{st}</li>
                        ))}
                      </ol>
                      <p className="cap">To tick it: {entry.pass}</p>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        }
        extraReady={complete}
        extraDirty={ticked.size > 0}
        phrase={PAYMENTS_VERIFY_PHRASE}
        confirmLabel="Record the verification"
        note={{
          label: "What you tested, and where (at least 10 characters)",
          required: true,
          minLength: 10,
          maxLength: 500,
        }}
        describe={describePaymentError}
        onClose={() => {
          setOpen(false);
          setTicked(new Set());
        }}
        onConfirm={({ phrase, note }) =>
          verifyPaymentPath({ confirm: phrase, checks: [...all], note })
        }
        onDone={() => {
          setOpen(false);
          setTicked(new Set());
          toast.show("Verification recorded. Payments stay switched off until you switch them on.");
          onChanged();
        }}
      />
    </>
  );
}

// ---- draft expiry -----------------------------------------------------------------------------

const DEFAULT_EXPIRY = 5;
const MAX_EXPIRY = 30;

export function DraftExpiryCard({
  data,
  onChanged,
}: {
  data: PaymentsSettingsResponse;
  onChanged: () => void;
}) {
  const toast = useToast();
  const stored = data.draftExpiryDays ?? DEFAULT_EXPIRY;
  const [text, setText] = useState(String(stored));
  const { state, run } = useAction(describePaymentError);
  const ok = /^[0-9]{1,2}$/.test(text);
  const days = ok ? toSafeNumber(BigInt(text)) : 0;
  const valid = ok && days >= 1 && days <= MAX_EXPIRY;
  async function save() {
    if (!valid) return;
    const r = await run(() => setDraftExpiryDays(days));
    if (r?.ok) {
      toast.show("Draft expiry saved.");
      onChanged();
    }
  }
  return (
    <Card>
      <h2 className="h2">Draft expiry</h2>
      <p className="lede">
        A payment draft that nobody approves in the Revolut app within {stored}{" "}
        {stored === 1 ? "day" : "days"} is marked as failed here. Delete it in the Revolut app too.
      </p>
      <label className="field">
        Days until an unapproved draft expires (1 to {MAX_EXPIRY})
        <input
          className="input"
          inputMode="numeric"
          value={text}
          aria-invalid={valid ? undefined : true}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {!valid && <p className="cap">Enter a whole number from 1 to {MAX_EXPIRY}.</p>}
      {state.needsStepUp && <StepUpNotice />}
      {state.error && <ErrorLine>{state.error}</ErrorLine>}
      <div className="stack-row">
        <Button
          variant="primary"
          disabled={!valid || state.busy || (valid && days === stored)}
          onClick={() => void save()}
        >
          Save draft expiry
        </Button>
      </div>
    </Card>
  );
}

// ---- unknown outcomes -------------------------------------------------------------------------

type Unknown = PaymentDto | BatchDto;

/**
 * Requests whose outcome is unknown. Only an administrator, with a fresh sign-in and the typed
 * phrase, may call one "not sent", and only after a recent lookup at Revolut said it has no such
 * payment. The server decides whether the lookup counts; this screen only explains and asks.
 */
export function UnknownOutcomesCard() {
  const toast = useToast();
  const res = useResource<Unknown[]>("payments-unknown", async (signal) => {
    const [p, b] = await Promise.all([
      listPayments({ status: "outcome_unknown", limit: 50 }, signal),
      listPaymentBatches({ status: "outcome_unknown", limit: 50 }, signal),
    ]);
    return [...b.items, ...p.items];
  });
  const [target, setTarget] = useState<Unknown | null>(null);
  return (
    <Card>
      <h2 className="h2">Unknown outcomes</h2>
      <p className="lede">
        Requests where we could not confirm whether the bank received them. They are never sent
        again by the app.
      </p>
      <p className="cap">
        Mark one as not sent only when Revolut was asked for it at least {MIN_AGE_TEXT} after it
        became unknown, in the last 30 minutes, and said it has no such payment. If the server
        refuses, the check is not recent or not late enough: wait for the next one. If you are not
        sure, look in the Revolut app first. Marking a payment as not sent that was sent can lead to
        a second payment.
      </p>
      {res.status === "loading" && <Skeleton height={40} />}
      {res.status === "error" && (
        <ErrorNotice message={describeLoadError(res.error)} onRetry={res.reload} />
      )}
      {res.status === "ready" && res.data !== null && res.data.length === 0 && (
        <p>0 requests are waiting on an unknown outcome.</p>
      )}
      {res.status === "ready" && res.data !== null && res.data.length > 0 && (
        <ul className="pay-list pay-unknown" aria-label="Requests with an unknown outcome">
          {res.data.map((u) => (
            <li key={`${u.kind}:${u.id}`}>
              <span>
                {u.kind === "payment" ? (
                  <>
                    <Money minor={u.amountMinor} currency={u.currency} /> to {u.supplierName}
                    {u.invoiceNumber ? ` · ${u.invoiceNumber}` : ""}
                  </>
                ) : (
                  <>
                    <Money minor={u.totalMinor} currency={u.currency} /> for {u.itemCount} bills
                  </>
                )}{" "}
                <Chip tone="warn">Not confirmed</Chip>
              </span>
              <span className="cap">
                {" "}
                Became unknown {formatAgo(Date.now(), Date.parse(u.updatedAt ?? u.createdAt))} (
                {formatDateTime(u.updatedAt ?? u.createdAt)}).
              </span>{" "}
              <Button
                size="sm"
                aria-label={`Mark as not sent, ${u.kind === "payment" ? u.supplierName : `batch of ${u.itemCount} bills`}`}
                onClick={() => setTarget(u)}
              >
                Mark as not sent
              </Button>
            </li>
          ))}
        </ul>
      )}
      <TypedPhraseSheet
        open={target !== null}
        title="Mark as not sent"
        intro={
          <>
            <p className="lede">
              You are saying that this was never sent to the bank. If it was, paying the bill again
              pays it twice.
            </p>
            <p className="cap">
              The server accepts this only if Revolut said, in the last 30 minutes and at least{" "}
              {MIN_AGE_TEXT} after it became unknown, that it has no such payment.
            </p>
          </>
        }
        phrase={PAYMENTS_RESOLVE_PHRASE}
        confirmLabel="Mark as not sent"
        describe={describePaymentError}
        onClose={() => setTarget(null)}
        onConfirm={({ phrase }) =>
          target === null
            ? Promise.reject(new Error("no target"))
            : resolveNotSent(target.kind satisfies SubjectKind, target.id, phrase)
        }
        onDone={() => {
          setTarget(null);
          toast.show("Marked as not sent. The bill can be paid again with a new request.");
          res.refresh();
        }}
        onFailed={() => res.refresh()}
      />
    </Card>
  );
}

// ---- preview payment --------------------------------------------------------------------------

const STEP_WORDS: Record<string, string> = {
  counterparty: "Create the payee",
  pay: "Pay directly",
  draft: "Create the draft",
};

function PreviewResult({ r }: { r: PaymentPreviewResponse }): ReactNode {
  return (
    <div className="pay-preview" data-testid="preview-result">
      <p className="cap">
        Mode: {r.mode === "drafts" ? "draft in the Revolut app" : "one-click pay"}. Request id{" "}
        <code>{r.requestId}</code>. No call was made to the bank.
      </p>
      {r.calls.map((c, i) => (
        <section key={`${c.step}:${i}`} className="pay-preview-call">
          <h3 className="h3">
            {i + 1}. {STEP_WORDS[c.step] ?? "A bank call"}
          </h3>
          <p className="cap">
            <code>
              {c.method} {c.path}
            </code>{" "}
            <Chip tone={c.gateAccepts ? "ok" : "warn"}>
              {c.gateAccepts ? "Accepted by the gate" : "Refused by the gate"}
            </Chip>
            {c.usesPlaceholderPayee && (
              <>
                {" "}
                <Chip tone="gold">Payee does not exist yet</Chip>
              </>
            )}
          </p>
          {c.sha256 ? (
            <p className="cap">
              SHA-256 of the bytes sent: <code className="pay-hash">{c.sha256}</code>
            </p>
          ) : (
            <p className="cap">No hash is shown for this step.</p>
          )}
          <pre
            className="pay-body"
            tabIndex={0}
            aria-label={`Body of call ${i + 1}, bank account masked`}
          >
            {c.body}
          </pre>
        </section>
      ))}
    </div>
  );
}

export function PreviewCard() {
  const [kind, setKind] = useState<SubjectKind>("payment");
  const [idText, setIdText] = useState("");
  const [result, setResult] = useState<PaymentPreviewResponse | null>(null);
  const { state, run } = useAction(describePaymentError);
  const idOk = /^[1-9][0-9]{0,9}$/.test(idText);
  async function go() {
    if (!idOk) return;
    setResult(null);
    const r = await run(() => previewPayment(kind, toSafeNumber(BigInt(idText))));
    if (r?.ok) setResult(r.value);
  }
  return (
    <Card>
      <h2 className="h2">Preview payment</h2>
      <p className="lede">
        Shows the exact requests that sending a payment or batch would make, and their hashes, to
        compare with a call made by hand on the sandbox. Nothing is sent, and the bank account is
        always shown masked.
      </p>
      <div className="pay-form">
        <fieldset className="pay-kind">
          <legend className="h3">What to preview</legend>
          <label className="check-inline">
            <input
              type="radio"
              name="preview-kind"
              checked={kind === "payment"}
              onChange={() => setKind("payment")}
            />
            A payment
          </label>
          <label className="check-inline">
            <input
              type="radio"
              name="preview-kind"
              checked={kind === "batch"}
              onChange={() => setKind("batch")}
            />
            A batch
          </label>
        </fieldset>
        <label className="field">
          Request number
          <input
            className="input"
            inputMode="numeric"
            value={idText}
            aria-invalid={idText !== "" && !idOk ? true : undefined}
            onChange={(e) => setIdText(e.target.value)}
          />
        </label>
      </div>
      {state.needsStepUp && <StepUpNotice />}
      {state.error && <ErrorLine>{state.error}</ErrorLine>}
      <div className="stack-row">
        <Button variant="primary" disabled={!idOk || state.busy} onClick={() => void go()}>
          {state.busy ? "Preparing" : "Preview"}
        </Button>
      </div>
      {result !== null && <PreviewResult r={result} />}
    </Card>
  );
}
