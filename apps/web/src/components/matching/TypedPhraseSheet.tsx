import { useEffect, useState, type ReactNode } from "react";
import { phraseMatches } from "@camelthorn/core";
import { Button } from "@camelthorn/ui";
import { useAction } from "../../lib/useAction";
import { DrillSheet } from "../DrillSheet";
import { ErrorLine, StepUpNotice } from "./MatchParts";

/**
 * A sheet for a change that needs a typed phrase (and often a note): the confirm button stays
 * disabled until the phrase is typed exactly. The server checks the phrase and the fresh Google
 * sign-in again; a missing sign-in shows the sign-in button and changes nothing.
 */
export function TypedPhraseSheet({
  open,
  title,
  intro,
  phrase,
  confirmLabel,
  note,
  onClose,
  onConfirm,
  onDone,
}: {
  open: boolean;
  title: string;
  intro: ReactNode;
  /** The text that must be typed exactly; omit for a note-and-confirm sheet. */
  phrase?: string;
  confirmLabel: string;
  /** Ask for a written note; `required` keeps the button disabled while it is empty. */
  note?: { label: string; required: boolean };
  onClose: () => void;
  onConfirm: (v: { phrase: string; note: string }) => Promise<unknown>;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [text, setText] = useState("");
  const { state, run, clear } = useAction();
  useEffect(() => {
    if (open) {
      setTyped("");
      setText("");
      clear();
    }
  }, [open, clear]);
  const noteOk = !note || !note.required || text.trim() !== "";
  // Exact, case-sensitive, NOT trimmed (core phraseMatches; the server compares with === too).
  const ready = (phrase === undefined || phraseMatches(typed, phrase)) && noteOk;
  async function go() {
    const r = await run(() => onConfirm({ phrase: typed, note: text.trim() }));
    if (r?.ok) onDone();
  }
  return (
    <DrillSheet
      open={open}
      title={title}
      onClose={onClose}
      dirty={!state.busy && (typed !== "" || text.trim() !== "")}
    >
      <div className="mt-phrase">
        {intro}
        {note && (
          <label className="field">
            {note.label}
            <textarea
              className="input mt-note"
              rows={3}
              maxLength={200}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        )}
        {phrase !== undefined && (
          <label className="field">
            Type “{phrase}” to confirm
            <input
              className="input"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
        )}
        {state.needsStepUp && <StepUpNotice />}
        {state.error && <ErrorLine>{state.error}</ErrorLine>}
        <div className="stack-row">
          <Button variant="primary" disabled={!ready || state.busy} onClick={() => void go()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </DrillSheet>
  );
}
