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
  extra,
  extraReady = true,
  extraDirty = false,
  onClose,
  onConfirm,
  onDone,
  onFailed,
}: {
  open: boolean;
  title: string;
  intro: ReactNode;
  /** The text that must be typed exactly; omit for a note-and-confirm sheet. */
  phrase?: string;
  confirmLabel: string;
  /**
   * Ask for a written note; `required` keeps the button disabled while it is empty, `minLength`
   * while it is shorter (the server's own bounds, so a short note is caught before sending).
   */
  note?: { label: string; required: boolean; minLength?: number; maxLength?: number };
  /** More inputs shown before the note (tick boxes, pickers); the caller owns their state. */
  extra?: ReactNode;
  /** The extra inputs are complete; the confirm button stays disabled until they are. */
  extraReady?: boolean;
  /** The extra inputs hold something that closing would lose. */
  extraDirty?: boolean;
  onClose: () => void;
  onConfirm: (v: { phrase: string; note: string }) => Promise<unknown>;
  /** Called with the server's answer after a successful confirm. */
  onDone: (value: unknown) => void;
  /** Called after a refusal (the error is shown here already), e.g. to refresh what is behind. */
  onFailed?: (error: unknown) => void;
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
  const min = note?.minLength ?? 1;
  const noteOk = !note || (!note.required && text.trim() === "") || text.trim().length >= min;
  const noteShort = note !== undefined && text.trim() !== "" && text.trim().length < min;
  // Exact, case-sensitive, NOT trimmed (core phraseMatches; the server compares with === too).
  const ready = (phrase === undefined || phraseMatches(typed, phrase)) && noteOk && extraReady;
  async function go() {
    const r = await run(() => onConfirm({ phrase: typed, note: text.trim() }));
    if (r?.ok) onDone(r.value);
    else if (r && !r.ok) onFailed?.(r.error);
  }
  return (
    <DrillSheet
      open={open}
      title={title}
      onClose={onClose}
      dirty={!state.busy && (typed !== "" || text.trim() !== "" || extraDirty)}
    >
      <div className="mt-phrase">
        {intro}
        {extra}
        {note && (
          <label className="field">
            {note.label}
            <textarea
              className="input mt-note"
              rows={3}
              maxLength={note.maxLength ?? 200}
              value={text}
              aria-describedby={noteShort ? "tps-note-short" : undefined}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        )}
        {noteShort && (
          <p id="tps-note-short" className="cap">
            Write at least {min} characters.
          </p>
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
