import { useState } from "react";
import type { MatchDto } from "@camelthorn/core";
import { Button } from "@camelthorn/ui";
import { undoMatch } from "../../api-matching";
import {
  ALREADY_BOOKED_TEXT,
  NOT_BOOKED,
  describeMatchError,
  isStale,
} from "../../lib/matching-labels";
import { useAction } from "../../lib/useAction";
import { ErrorLine, StepUpNotice } from "./MatchParts";

/** True when Undo is still possible: the match is live and Exact has not booked it. */
export function canUndo(m: MatchDto): boolean {
  return m.status === "live" && m.undoAvailable && m.exactState === NOT_BOOKED;
}

/**
 * Undo of one match: a written reason, then a confirmation. Disabled with the reason when Exact
 * has already booked it (it must be reversed there). Waits for the server; the caller refetches.
 */
export function UndoPanel({
  match,
  canAct,
  onDone,
  onStale,
}: {
  match: MatchDto;
  canAct: boolean;
  /** The match was undone. */
  onDone: () => void;
  /** The server said the data moved (409 and the like): say why, then refresh. */
  onStale: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const { state, run, clear } = useAction();
  if (!canAct) return null;
  if (!canUndo(match)) {
    return (
      <div className="mt-undo">
        <Button disabled aria-describedby={`undo-why-${match.id}`}>
          Undo
        </Button>
        <p id={`undo-why-${match.id}`} className="cap">
          {match.exactState === NOT_BOOKED
            ? "This match can no longer be undone."
            : ALREADY_BOOKED_TEXT}
        </p>
      </div>
    );
  }
  const text = reason.trim();
  const valid = text.length >= 1 && text.length <= 200;

  async function confirm() {
    const r = await run(() => undoMatch(match.id, { reason: text }));
    if (r?.ok) onDone();
    else if (r && isStale(r.error)) {
      // The caller shows the sentence once (and refreshes); no second copy here.
      const message = describeMatchError(r.error);
      clear();
      setConfirming(false);
      onStale(message);
    }
  }

  return (
    <div className="mt-undo">
      {!confirming ? (
        <>
          <label className="field">
            Why are you undoing this match?
            <input
              className="input"
              value={reason}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div>
            <Button disabled={!valid} onClick={() => setConfirming(true)}>
              Undo…
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-confirm" role="group" aria-label="Confirm undo">
          <p>
            Undo this match? The bank line goes back to the review list and its invoices are open
            again in this app. Nothing changes in Exact, because this match is not booked there.
            Reason: {text}
          </p>
          {state.needsStepUp && <StepUpNotice />}
          {state.error && <ErrorLine>{state.error}</ErrorLine>}
          <div className="stack-row">
            <Button variant="primary" disabled={state.busy} onClick={() => void confirm()}>
              Undo this match
            </Button>
            <Button disabled={state.busy} onClick={() => setConfirming(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
