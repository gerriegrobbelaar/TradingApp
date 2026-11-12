import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@camelthorn/ui";
import { resolveDqIssue, snoozeDqIssue } from "../../api-dq";
import { SNOOZE_CHOICES, describeDqError } from "../../lib/dq-labels";
import { useAction } from "../../lib/useAction";
import { DrillSheet } from "../DrillSheet";
import { ErrorLine } from "../matching/MatchParts";

export type IssueChange = { kind: "snoozed"; until: string } | { kind: "resolved" };

type Mode = "view" | "snooze" | "resolve";

const NOTE_MAX = 200;

/**
 * One data quality issue: what it is, a Fix link, and (finance and admin) Snooze and Resolve. Both
 * writes ask for a short note and wait for the server. There is no way to take either back through
 * the API, so the sheet says so before it sends: a snooze ends by itself, and a resolved issue
 * that is still true is reopened by the next check.
 */
export function IssueSheet({
  open,
  onClose,
  title,
  subtitle,
  issueId,
  fixPath,
  fixLabel = "Fix",
  canAct,
  children,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  issueId: number | null;
  fixPath: string;
  fixLabel?: string;
  canAct: boolean;
  /** Extra facts shown above the actions. */
  children?: ReactNode;
  onChanged: (c: IssueChange) => void;
}) {
  const [mode, setMode] = useState<Mode>("view");
  const [note, setNote] = useState("");
  const [days, setDays] = useState(7);
  const { state, run, clear } = useAction(describeDqError);
  useEffect(() => {
    if (open) {
      setMode("view");
      setNote("");
      setDays(7);
      clear();
    }
  }, [open, issueId, clear]);

  const text = note.trim();
  async function send() {
    if (issueId === null || text === "") return;
    if (mode === "snooze") {
      const until = new Date(Date.now() + days * 86_400_000).toISOString();
      const r = await run(() => snoozeDqIssue(issueId, { until, note: text }));
      if (r?.ok) onChanged({ kind: "snoozed", until });
    } else if (mode === "resolve") {
      const r = await run(() => resolveDqIssue(issueId, { note: text }));
      if (r?.ok) onChanged({ kind: "resolved" });
    }
  }

  return (
    <DrillSheet
      open={open}
      title={title}
      {...(subtitle ? { subtitle } : {})}
      onClose={onClose}
      viewKey={mode}
      dirty={!state.busy && text !== ""}
    >
      {children}
      {mode === "view" ? (
        <div className="dq-actions">
          <Link className="btn primary" to={fixPath} data-autofocus>
            {fixLabel}
          </Link>
          {canAct && issueId !== null && (
            <>
              <Button onClick={() => setMode("snooze")}>Snooze</Button>
              <Button onClick={() => setMode("resolve")}>Resolve with a note</Button>
            </>
          )}
        </div>
      ) : (
        <form
          className="dq-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <h3 className="h3" data-autofocus tabIndex={-1}>
            {mode === "snooze" ? "Snooze this issue" : "Resolve this issue"}
          </h3>
          <p className="cap">
            {mode === "snooze"
              ? "It leaves the lists until the time is up, then it comes back if it is still true. You cannot take a snooze back."
              : "If the problem is still there at the next check, the issue is reopened. To accept a known condition, snooze it instead. You cannot take this back."}
          </p>
          {mode === "snooze" && (
            <label className="field">
              Snooze for
              <select
                className="input"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {SNOOZE_CHOICES.map((c) => (
                  <option key={c.days} value={c.days}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Note (required)
            <textarea
              className="input"
              rows={3}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <p className="cap">
            {NOTE_MAX - note.length} characters left. Do not paste bank account numbers.
          </p>
          {state.error && <ErrorLine>{state.error}</ErrorLine>}
          <div className="stack-row">
            <Button type="submit" variant="primary" disabled={text === "" || state.busy}>
              {mode === "snooze" ? "Snooze" : "Resolve"}
            </Button>
            <Button
              type="button"
              disabled={state.busy}
              onClick={() => {
                setMode("view");
                clear();
              }}
            >
              Back
            </Button>
          </div>
        </form>
      )}
    </DrillSheet>
  );
}
