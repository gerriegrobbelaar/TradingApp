import { useMemo, useState } from "react";
import { ApiError } from "../../api";
import {
  AUTO_MATCH_CONFIRM_PHRASE,
  MAX_PATTERN_LENGTH,
  MAX_REGEX_INPUT,
  phraseMatches,
  type MatchPatternRequest,
  type MatchPatternDto,
  type MatchPatternsResponse,
} from "@camelthorn/core";
import { Button, Card, Chip, Skeleton } from "@camelthorn/ui";
import { createPattern, deletePattern, getPatterns, updatePattern } from "../../api-matching";
import { describeLoadError } from "../../lib/errors";
import {
  EMPTY_PATTERN,
  checkPattern,
  regexProblem,
  testPattern,
  type PatternForm,
} from "../../lib/matching-settings";
import { useAction } from "../../lib/useAction";
import { useResource } from "../../lib/useResource";
import { useToast } from "../../toasts";
import { DrillSheet } from "../DrillSheet";
import { ErrorNotice } from "../EmptyState";
import { ConfirmButton, ErrorLine, StepUpNotice } from "./MatchParts";

const formOf = (p: MatchPatternDto): PatternForm => ({
  name: p.name,
  ledgerAccountCode: p.ledgerAccountCode,
  counterpartyNameRegex: p.counterpartyNameRegex ?? "",
  referenceRegex: p.referenceRegex ?? "",
  type: p.type ?? "",
  direction: p.direction ?? "",
  maxAmountMinor: p.maxAmountMinor === null ? "" : String(p.maxAmountMinor),
  enabled: p.enabled,
});

function conditions(p: MatchPatternDto): string {
  const parts: string[] = [];
  if (p.counterpartyNameRegex) parts.push(`name matches ${p.counterpartyNameRegex}`);
  if (p.referenceRegex) parts.push(`reference matches ${p.referenceRegex}`);
  if (p.type) parts.push(`type ${p.type}`);
  if (p.direction) parts.push(p.direction === "in" ? "money in" : "money out");
  if (p.maxAmountMinor !== null) parts.push(`up to ${p.maxAmountMinor} minor units`);
  return parts.join("; ");
}

/** The fields that decide which lines a pattern books (core patternKey); the name does not. */
function matchKey(p: {
  ledgerAccountCode: string;
  counterpartyNameRegex?: string | null;
  referenceRegex?: string | null;
  type?: string | null;
  direction?: string | null;
  maxAmountMinor?: number | null;
}): string {
  return JSON.stringify([
    p.ledgerAccountCode,
    p.counterpartyNameRegex ?? null,
    p.referenceRegex ?? null,
    p.type ?? null,
    p.direction ?? null,
    p.maxAmountMinor ?? null,
  ]);
}

/**
 * Does saving this pattern let AUTOMATIC matching book more lines (the server's rule, review U2)?
 * Only while automatic matching and automatic ledger patterns are both on: a new enabled pattern,
 * switching one on, or changing the match fields of an enabled one. Renaming, disabling never.
 */
export function patternLoosens(
  autoLedger: boolean,
  before: MatchPatternDto | null,
  req: MatchPatternRequest,
): boolean {
  if (!autoLedger || req.enabled === false) return false;
  if (before === null || !before.enabled) return true;
  return matchKey(before) !== matchKey(req);
}

function PatternSheet({
  open,
  editing,
  autoLedger,
  phrase,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: MatchPatternDto | null;
  /** Automatic matching AND automatic ledger patterns are on. */
  autoLedger: boolean;
  phrase: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [serverAsks, setServerAsks] = useState(false);
  const toast = useToast();
  const initial = useMemo(() => (editing ? formOf(editing) : EMPTY_PATTERN), [editing]);
  const [form, setForm] = useState<PatternForm>(initial);
  const [text, setText] = useState("");
  const { state, run } = useAction();
  const check = useMemo(() => checkPattern(form), [form]);
  const results = useMemo(() => testPattern(form, text), [form, text]);
  const errors = check.ok ? {} : check.errors;
  const set = <K extends keyof PatternForm>(k: K, v: PatternForm[K]) =>
    setForm({ ...form, [k]: v });

  const needsPhrase =
    serverAsks || (check.ok && patternLoosens(autoLedger, editing, check.request));
  const phraseOk = !needsPhrase || phraseMatches(typed, phrase);

  async function save() {
    if (!check.ok || !phraseOk) return;
    const body: MatchPatternRequest = needsPhrase
      ? { ...check.request, confirm: typed }
      : check.request;
    const r = await run(() => (editing ? updatePattern(editing.id, body) : createPattern(body)));
    if (r?.ok) {
      toast.show(editing ? "Saved the pattern." : "Added the pattern.");
      onSaved();
    } else if (
      r &&
      !r.ok &&
      r.error instanceof ApiError &&
      r.error.code === "confirmation_required"
    ) {
      // The server's rule is authoritative: show the phrase field and let the person retry.
      setServerAsks(true);
    }
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || text !== "" || typed !== "";

  const field = (key: keyof PatternForm, label: string, hint?: string, mono = false) => (
    <label className="field">
      {label}
      <input
        className={`input${mono ? " mt-mono" : ""}`}
        autoComplete="off"
        spellCheck={false}
        maxLength={mono ? MAX_PATTERN_LENGTH : 80}
        value={String(form[key])}
        aria-invalid={errors[key] ? true : undefined}
        onChange={(e) => set(key, e.target.value as never)}
      />
      <span className={errors[key] ? "cap bad" : "cap"}>{errors[key] ?? hint ?? ""}</span>
    </label>
  );

  return (
    <DrillSheet
      open={open}
      title={editing ? "Edit ledger pattern" : "Add ledger pattern"}
      onClose={onClose}
      viewKey={String(editing?.id ?? "new")}
      dirty={dirty && !state.busy}
    >
      <form
        className="mt-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="cap">
          A pattern suggests a ledger account for a bank line when every condition you fill in fits.
          Patterns use a safe subset of regular expressions: no back-references, no look-ahead, no
          nested repeats and only a few optional parts. A change affects future matching runs only;
          matches already recorded stay as they are.
        </p>
        {field("name", "Name", "For example Bank costs")}
        {field("ledgerAccountCode", "Ledger account code", "For example 4500")}
        {field(
          "counterpartyNameRegex",
          "Counterparty name pattern",
          "Optional. Case does not matter.",
          true,
        )}
        {field("referenceRegex", "Reference pattern", "Optional.", true)}
        {field("type", "Payment type", "Optional, for example card_payment or fee.")}
        <label className="field">
          Direction
          <select
            className="input"
            value={form.direction}
            onChange={(e) => set("direction", e.target.value as PatternForm["direction"])}
          >
            <option value="">Either</option>
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </select>
        </label>
        {field(
          "maxAmountMinor",
          "Largest amount (minor units)",
          "Optional. In cents, for example 2500 for 25,00.",
        )}
        <label className="choice">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          <span>Pattern is on</span>
        </label>
        <fieldset className="mt-test">
          <legend className="h3">Test against this text</legend>
          <label className="field">
            Text to test
            <input
              className="input"
              value={text}
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_REGEX_INPUT}
              aria-describedby="mt-test-hint"
              onChange={(e) => setText(e.target.value.slice(0, MAX_REGEX_INPUT))}
            />
          </label>
          <p id="mt-test-hint" className="cap">
            Tested in this browser with the same safe rules as the server, on the first{" "}
            {MAX_REGEX_INPUT} characters. Nothing is saved.
          </p>
          <ul aria-label="Test results" role="status" className="mt-test-results">
            {text !== "" && results.length === 0 && (
              <li className="cap">Fill in a valid name or reference pattern to test it.</li>
            )}
            {text !== "" &&
              results.map((r) => (
                <li key={r.field}>
                  {r.label} pattern: <strong>{r.matches ? "matches" : "does not match"}</strong>
                </li>
              ))}
          </ul>
        </fieldset>
        {errors.test && (
          <p role="alert" className="cap bad">
            {errors.test}
          </p>
        )}
        {needsPhrase && (
          <div role="group" aria-labelledby="mt-pattern-phrase-h" className="notice warn">
            <p id="mt-pattern-phrase-h">
              Automatic matching and automatic ledger patterns are on, so this pattern can book
              lines to a ledger account without a person. Type the confirmation to save it.
            </p>
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
          </div>
        )}
        {state.needsStepUp && <StepUpNotice />}
        {state.error && <ErrorLine>{state.error}</ErrorLine>}
        <div className="stack-row">
          <Button type="submit" variant="primary" disabled={!check.ok || !phraseOk || state.busy}>
            {editing ? "Save pattern" : "Add pattern"}
          </Button>
        </div>
      </form>
    </DrillSheet>
  );
}

/** Ledger patterns: bank costs, card payments and the like. Admin; writes need a fresh sign-in. */
export function PatternsCard({
  autoLedger = false,
  phrase = AUTO_MATCH_CONFIRM_PHRASE,
}: {
  /** Automatic matching AND automatic ledger patterns are on (from GET /api/matching/config). */
  autoLedger?: boolean;
  phrase?: string;
} = {}) {
  const toast = useToast();
  const res = useResource<MatchPatternsResponse>("match-patterns", (s) => getPatterns(s));
  const [sheet, setSheet] = useState<{ editing: MatchPatternDto | null; n: number } | null>(null);
  const [opens, setOpens] = useState(0);
  const openSheet = (editing: MatchPatternDto | null) => {
    setOpens((n) => n + 1);
    setSheet({ editing, n: opens + 1 });
  };
  const { state, run } = useAction();

  async function remove(p: MatchPatternDto) {
    const r = await run(() => deletePattern(p.id));
    if (r?.ok) {
      toast.show("Deleted the pattern.");
      res.reload();
    }
  }

  return (
    <Card>
      <div className="row-between">
        <h2 className="h2">Ledger patterns</h2>
        <Button onClick={() => openSheet(null)}>Add pattern…</Button>
      </div>
      <p className="lede">
        Patterns suggest a ledger account for lines without an invoice, such as bank fees. They are
        only suggestions unless you allow automatic ledger matches in the thresholds. A change
        affects future matching runs only.
      </p>
      {state.needsStepUp && <StepUpNotice />}
      {state.error && <ErrorLine>{state.error}</ErrorLine>}
      {res.status === "error" && (
        <ErrorNotice message={describeLoadError(res.error)} onRetry={res.reload} />
      )}
      {res.status === "loading" && (
        <div aria-busy="true">
          <Skeleton height={40} />
          <p role="status" className="sr-only">
            Loading
          </p>
        </div>
      )}
      {res.status === "ready" && res.data && res.data.patterns.length === 0 && (
        <p className="cap">No patterns yet.</p>
      )}
      {res.status === "ready" && res.data && res.data.patterns.length > 0 && (
        <ul className="mt-pattern-list" aria-label="Ledger patterns">
          {res.data.patterns.map((p) => (
            <li key={p.id} className="mt-pattern-row">
              <div>
                <strong>{p.name}</strong>{" "}
                <span className="cap">ledger account {p.ledgerAccountCode}</span>{" "}
                <Chip tone={p.enabled ? "ok" : "neutral"}>{p.enabled ? "On" : "Off"}</Chip>
                <p className="cap mt-mono">{conditions(p)}</p>
                {[p.counterpartyNameRegex, p.referenceRegex].some(
                  (r) => r !== null && r !== "" && regexProblem(r) !== null,
                ) && (
                  <p role="note" className="notice warn">
                    This pattern is outside the safe rules now, so matching does not run until it is
                    edited or deleted.
                  </p>
                )}
              </div>
              <div className="stack-row">
                <Button size="sm" aria-label={`Edit ${p.name}`} onClick={() => openSheet(p)}>
                  Edit
                </Button>
                <ConfirmButton
                  label="Delete"
                  ariaLabel={`Delete ${p.name}`}
                  question={`Delete ${p.name}? Future runs stop suggesting it; recorded matches stay.`}
                  confirmLabel="Yes, delete"
                  busy={state.busy}
                  onConfirm={() => void remove(p)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <PatternSheet
        key={sheet?.n ?? 0}
        open={sheet !== null}
        editing={sheet?.editing ?? null}
        autoLedger={autoLedger}
        phrase={phrase}
        onClose={() => setSheet(null)}
        onSaved={() => {
          setSheet(null);
          res.reload();
        }}
      />
    </Card>
  );
}
