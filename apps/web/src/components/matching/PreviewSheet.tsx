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
import { NO_VALUE, formatDateTime, formatMoney } from "../../lib/format";
import { NOT_BOOKED, deferredChipText } from "../../lib/matching-labels";
import { maskDeep } from "../../lib/mask";
import { useAction } from "../../lib/useAction";
import { useResource } from "../../lib/useResource";
import { useToast } from "../../toasts";
import { DrillSheet } from "../DrillSheet";
import { ErrorNotice } from "../EmptyState";
import { ErrorLine, StepUpNotice } from "./MatchParts";

/** At most this many matches per preview (the server enforces the same limit). */
export const PREVIEW_MAX = 3;

/** The body as shown: pretty JSON for objects, the text itself for XML. IBAN-masked again here. */
export function bodyText(body: unknown): string {
  const safe = maskDeep(body);
  return typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
}

function CodeBlock({ title, text }: { title: string; text: string }) {
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast.show("Copied.");
    } catch {
      toast.show("Could not copy. Select the text and copy it yourself.");
    }
  }
  return (
    <div className="mt-code">
      <div className="row-between">
        <h4 className="h4">{title}</h4>
        <Button size="sm" aria-label={`Copy ${title}`} onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      <pre className="mt-pre" tabIndex={0} aria-label={title}>
        {text}
      </pre>
    </div>
  );
}

function PreviewItem({ item }: { item: BookingPreviewItem }) {
  const hashes = Object.entries(item.hashes).filter(([, v]) => typeof v === "string");
  return (
    <section className="mt-preview-item" aria-label={`Preview of match ${item.matchId}`}>
      <h3 className="h3">Match {item.matchId}</h3>
      {item.wouldDefer ? (
        <p role="note" className="notice warn">
          <Chip tone="warn">{deferredChipText(item.wouldDefer.code)}</Chip> It would wait and
          nothing would be booked.
        </p>
      ) : (
        <p role="note" className="cap">
          Nothing blocks this match right now.
        </p>
      )}
      {item.plan.length > 0 && (
        <>
          <h4 className="h4">What would happen, in order</h4>
          <ol className="mt-plan">
            {item.plan.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </>
      )}
      {item.bankEntryBody !== null && item.bankEntryBody !== undefined ? (
        <CodeBlock title="Bank entry body" text={bodyText(item.bankEntryBody)} />
      ) : (
        <p className="cap">No bank entry would be created for this match.</p>
      )}
      {item.matchSetXml ? (
        <CodeBlock title="Match body (XML)" text={bodyText(item.matchSetXml)} />
      ) : (
        <p className="cap">No match body could be built yet.</p>
      )}
      {hashes.length > 0 && (
        <dl className="dl">
          {hashes.map(([k, v]) => (
            <div className="dl-row" key={k}>
              <dt>{k === "bankEntry" ? "Bank entry SHA-256" : "Match SHA-256"}</dt>
              <dd>
                <code className="mt-mono">{String(v)}</code>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {Object.keys(item.reads).length > 0 && (
        <details>
          <summary>What was read from Exact</summary>
          <pre className="mt-pre" tabIndex={0} aria-label="What was read from Exact">
            {bodyText(item.reads)}
          </pre>
        </details>
      )}
    </section>
  );
}

/**
 * Preview booking (admin, fresh sign-in): builds the real request bodies and their hashes for up
 * to three matches with the real builders and read-only Exact reads, and shows them. It creates no
 * outbox row, changes no state and sends nothing to Exact.
 */
export function PreviewSheet({
  open,
  onClose,
  fixedMatchId,
}: {
  open: boolean;
  onClose: () => void;
  /** Preview exactly this match (opened from a match's detail); no list. */
  fixedMatchId?: number;
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
              <PreviewItem key={it.matchId} item={it} />
            ))}
          </div>
        )}
      </div>
    </DrillSheet>
  );
}
