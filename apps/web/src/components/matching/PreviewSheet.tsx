import { useEffect, useMemo, useState } from "react";
import type {
  BookingPreviewItem,
  BookingPreviewResponse,
  MatchAutoResponse,
} from "@camelthorn/core";
import { Button, Chip } from "@camelthorn/ui";
import { getMatchAuto, previewBooking } from "../../api-matching";
import { magnitude } from "../../lib/allocation";
import { describeLoadError } from "../../lib/errors";
import { NO_VALUE, formatCount, formatDateTime, formatMoney } from "../../lib/format";
import { NOT_BOOKED, previewOutcomeReason, previewReadErrorText } from "../../lib/matching-labels";
import { maskDeep, maskIbanLike } from "../../lib/mask";
import { useAction } from "../../lib/useAction";
import { useResource } from "../../lib/useResource";
import { useToast } from "../../toasts";
import { DrillSheet } from "../DrillSheet";
import { ErrorNotice } from "../EmptyState";
import { ErrorLine, StepUpNotice } from "./MatchParts";

/** At most this many matches per preview (the server enforces the same limit). */
export const PREVIEW_MAX = 3;

/** Longer text is cut for display (the server caps each body at 20,000 characters already). */
export const PREVIEW_DISPLAY_CAP = 40_000;

/** The worker's placeholder bank entry number (booking/preview.ts PREVIEW_PLACEHOLDER_ENTRY_NUMBER). */
export const PLACEHOLDER_ENTRY_NUMBER = "999999999";

/**
 * A body as shown: the server's exact text, so it can be compared and copied byte for byte. IBAN-
 * like text is masked again here (defence in depth; the server already masks bank text), and the
 * result says whether that changed anything, because a masked copy is no longer byte-identical.
 */
export function bodyText(body: unknown): { text: string; masked: boolean; cut: boolean } {
  const raw = typeof body === "string" ? body : (JSON.stringify(maskDeep(body), null, 2) ?? "");
  const safe = maskIbanLike(raw);
  const cut = safe.length > PREVIEW_DISPLAY_CAP;
  return {
    text: cut ? safe.slice(0, PREVIEW_DISPLAY_CAP) : safe,
    // Answers are masked at the API boundary already, so a mask may predate this function: look
    // for the mask's own shape too ("NL91****4300").
    masked: safe !== raw || /[A-Z]{2}[0-9]{2}[A-Z0-9]{0,4}\*{4}/.test(safe),
    cut,
  };
}

function CodeBlock({ id, title, body }: { id: string; title: string; body: unknown }) {
  const toast = useToast();
  const { text, masked, cut } = bodyText(body);
  const [said, setSaid] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setSaid(`Copied the ${title.toLowerCase()}.`);
      toast.show("Copied.");
    } catch {
      setSaid("Could not copy. Select the text and copy it yourself.");
    }
  }
  return (
    <div className="mt-code">
      <div className="row-between">
        <h4 className="h4" id={`${id}-h`}>
          {title}
        </h4>
        <Button size="sm" aria-label={`Copy ${title}`} disabled={cut} onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      <pre className="mt-pre" tabIndex={0} aria-label={title}>
        {text}
      </pre>
      {masked && (
        <p className="cap" role="note">
          Something that looks like an account number was masked here, so this text is not byte for
          byte what would be sent. Compare the SHA-256 instead.
        </p>
      )}
      {cut && (
        <p className="cap" role="note">
          This body is too long to show in full; only the start is shown and Copy is off. Compare
          the SHA-256 instead.
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  );
}

const MODE_TEXT: Record<"ledger" | "matched", string> = {
  ledger: "One bank entry on the ledger account (no invoice is matched).",
  matched:
    "A bank entry (unless another integration creates it), then a match of the bank line against the invoices in Exact.",
};

const PREFLIGHT_TEXT: Record<string, string> = {
  open_as_expected: "open as expected",
  already_settled: "already settled in Exact",
  changed: "changed in Exact since the match",
  inconclusive: "could not be checked",
};

const SOURCE_TEXT: Record<string, string> = {
  exact: "the latest entry in Exact",
  admin_opening_balance: "the opening balance from the account map",
};

function PreviewItem({
  item,
  currency,
}: {
  item: BookingPreviewItem;
  currency?: string | undefined;
}) {
  const reads = item.reads;
  const id = `pv-${item.matchId}`;
  return (
    <section className="mt-preview-item" aria-label={`Preview of match ${item.matchId}`}>
      <h3 className="h3">Match {item.matchId}</h3>
      {item.wouldDefer ? (
        <p role="note" className="notice warn">
          <Chip tone="warn">Would not be booked now</Chip>{" "}
          {capitalise(previewOutcomeReason(item.wouldDefer.code))}. Nothing would be sent for it.
        </p>
      ) : (
        <p role="note" className="cap">
          Nothing blocks this match right now.
        </p>
      )}
      {item.mode !== null && <p>{MODE_TEXT[item.mode]}</p>}
      {item.bankEntryBody !== null ? (
        <CodeBlock id={`${id}-be`} title="Bank entry body" body={item.bankEntryBody} />
      ) : (
        <p className="cap">No bank entry body: none would be created for this match.</p>
      )}
      {item.matchSetXml !== null ? (
        <>
          {item.matchSetBankLinePlaceholder && (
            <p role="note" className="notice warn">
              The bank line is not in Exact yet, so the match body uses the placeholder number{" "}
              {PLACEHOLDER_ENTRY_NUMBER}. Replace it with the real entry number before you upload it
              by hand; the SHA-256 below is of the body WITH the placeholder.
            </p>
          )}
          <CodeBlock id={`${id}-ms`} title="Match body (XML)" body={item.matchSetXml} />
        </>
      ) : (
        <p className="cap">No match body could be built yet.</p>
      )}
      {(item.bankEntryHash !== null || item.matchSetHash !== null) && (
        <dl className="dl">
          {item.bankEntryHash !== null && (
            <div className="dl-row">
              <dt>Bank entry SHA-256</dt>
              <dd>
                <code className="mt-mono">{item.bankEntryHash}</code>
              </dd>
            </div>
          )}
          {item.matchSetHash !== null && (
            <div className="dl-row">
              <dt>Match SHA-256</dt>
              <dd>
                <code className="mt-mono">{item.matchSetHash}</code>
              </dd>
            </div>
          )}
        </dl>
      )}
      <details>
        <summary>What was read from Exact</summary>
        <dl className="dl">
          <div className="dl-row">
            <dt>Duplicate probe</dt>
            <dd>
              {reads.probeHits === null
                ? "Not read"
                : formatCount(reads.probeHits, "line found", "lines found")}
            </dd>
          </div>
          <div className="dl-row">
            <dt>Latest closing balance</dt>
            <dd>
              {reads.closingBalanceMinor === null
                ? "Not known"
                : currency
                  ? formatMoney(reads.closingBalanceMinor, currency)
                  : `${reads.closingBalanceMinor} (minor units)`}
            </dd>
          </div>
          <div className="dl-row">
            <dt>Opening balance from</dt>
            <dd>
              {reads.openingBalanceSource === null
                ? NO_VALUE
                : (SOURCE_TEXT[reads.openingBalanceSource] ?? NO_VALUE)}
            </dd>
          </div>
          <div className="dl-row">
            <dt>Invoices in Exact</dt>
            <dd>
              {reads.preflight === null
                ? "Not read"
                : (PREFLIGHT_TEXT[reads.preflight] ?? NO_VALUE)}
            </dd>
          </div>
          {reads.readError !== null && (
            <div className="dl-row">
              <dt>Read problem</dt>
              <dd>{capitalise(previewReadErrorText(reads.readError))}.</dd>
            </div>
          )}
        </dl>
      </details>
    </section>
  );
}

const capitalise = (t: string): string => (t === "" ? t : t[0]?.toUpperCase() + t.slice(1));

/**
 * Preview booking (admin, fresh sign-in): builds the real request bodies and their hashes for up
 * to three matches with the real builders and read-only Exact reads, and shows them. It creates no
 * outbox row, changes no state and sends nothing to Exact.
 */
export function PreviewSheet({
  open,
  onClose,
  fixedMatchId,
  fixedCurrency,
}: {
  open: boolean;
  onClose: () => void;
  /** Preview exactly this match (opened from a match's detail); no list. */
  fixedMatchId?: number;
  /** The bank line's currency for that match (amounts read from Exact are shown in it). */
  fixedCurrency?: string;
}) {
  const list = useResource<MatchAutoResponse>(
    open && fixedMatchId === undefined ? "booking-preview-matches" : null,
    (s) => getMatchAuto({ limit: 25 }, s),
  );
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [result, setResult] = useState<BookingPreviewResponse | null>(null);
  const { state, run, clear } = useAction();
  useEffect(() => {
    if (open) {
      setPicked(new Set());
      setResult(null);
      clear();
    }
  }, [open, clear]);
  const live = useMemo(
    () =>
      (list.data?.items ?? []).filter(
        (r) => r.match.status === "live" && r.match.exactState === NOT_BOOKED,
      ),
    [list.data],
  );
  const ids = fixedMatchId !== undefined ? [fixedMatchId] : [...picked].sort((a, b) => a - b);
  const toggle = (id: number, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  async function go() {
    const r = await run(() => previewBooking({ matchIds: ids }));
    if (r?.ok) setResult(r.value);
  }
  return (
    <DrillSheet open={open} title="Preview booking" onClose={onClose}>
      <div className="mt-phrase">
        <p role="note">
          <strong>Nothing was sent to Exact.</strong> The preview builds what would be sent, and
          reads from Exact to check it. It records nothing and changes nothing. It needs a Google
          sign-in from the last 15 minutes.
        </p>
        {fixedMatchId === undefined && (
          <fieldset className="mt-checks">
            <legend>
              Pick up to {PREVIEW_MAX} matches that are not booked yet ({picked.size} picked)
            </legend>
            {list.status === "error" && (
              <ErrorNotice message={describeLoadError(list.error)} onRetry={list.reload} />
            )}
            {list.status === "loading" && <p className="cap">Loading matches.</p>}
            {list.status === "ready" && live.length === 0 && (
              <p className="cap">
                No automatic match is waiting to be booked. To preview a match made by a person,
                open it from the Bank screen and use Preview booking there.
              </p>
            )}
            <ul className="mt-check-list">
              {live.map((r) => {
                const on = picked.has(r.match.id);
                return (
                  <li key={r.match.id}>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        className="check"
                        checked={on}
                        disabled={!on && picked.size >= PREVIEW_MAX}
                        onChange={(e) => toggle(r.match.id, e.target.checked)}
                      />
                      <span>
                        {r.transaction.counterpartyName ?? r.transaction.description ?? NO_VALUE},{" "}
                        {formatMoney(magnitude(r.transaction.amountMinor), r.transaction.currency)},
                        matched {formatDateTime(r.match.createdAt)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        {state.needsStepUp && <StepUpNotice />}
        {state.error && <ErrorLine>{state.error}</ErrorLine>}
        <div className="stack-row">
          <Button
            variant="primary"
            disabled={ids.length === 0 || ids.length > PREVIEW_MAX || state.busy}
            onClick={() => void go()}
          >
            Preview booking
          </Button>
        </div>
        {result && (
          <div aria-live="polite">
            <p role="status">
              <strong>Nothing was sent to Exact.</strong>
            </p>
            {result.items.length === 0 && <p className="cap">The server returned no preview.</p>}
            {result.items.map((it) => (
              <PreviewItem
                key={it.matchId}
                item={it}
                currency={
                  fixedMatchId !== undefined
                    ? fixedCurrency
                    : live.find((r) => r.match.id === it.matchId)?.transaction.currency
                }
              />
            ))}
          </div>
        )}
      </div>
    </DrillSheet>
  );
}
