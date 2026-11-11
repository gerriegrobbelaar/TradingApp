import { useMemo, useState } from "react";
import type { MatchPatternDto, MatchPatternsResponse } from "@camelthorn/core";
import { Button, Card, Chip, Skeleton } from "@camelthorn/ui";
import { createPattern, deletePattern, getPatterns, updatePattern } from "../../api-matching";
import { describeLoadError } from "../../lib/errors";
import {
  EMPTY_PATTERN,
  checkPattern,
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

function PatternSheet({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: MatchPatternDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<PatternForm>(() => (editing ? formOf(editing) : EMPTY_PATTERN));
  const [text, setText] = useState("");
  const { state, run } = useAction();
  const check = useMemo(() => checkPattern(form), [form]);
  const results = useMemo(() => testPattern(form, text), [form, text]);
  const errors = check.ok ? {} : check.errors;
  const set = <K extends keyof PatternForm>(k: K, v: PatternForm[K]) =>
    setForm({ ...form, [k]: v });

  async function save() {
    if (!check.ok) return;
    const r = await run(() =>
      editing ? updatePattern(editing.id, check.request) : createPattern(check.request),
    );
    if (r?.ok) {
      toast.show(editing ? "Saved the pattern." : "Added the pattern.");
      onSaved();
    }
  }

  const field = (key: keyof PatternForm, label: string, hint?: string, mono = false) => (
    <label className="field">
      {label}
      <input
        className={`input${mono ? " mt-mono" : ""}`}
        autoComplete="off"
        spellCheck={false}
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
    >
      <form
        className="mt-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="cap">
          A pattern books a bank line to a ledger account when every condition you fill in fits.
          Patterns use a safe subset of regular expressions: no back-references, no look-ahead and
          no nested repeats.
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
              onChange={(e) => setText(e.target.value)}
            />
          </label>
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
        {state.needsStepUp && <StepUpNotice />}
        {state.error && <ErrorLine>{state.error}</ErrorLine>}
        <div className="stack-row">
          <Button type="submit" variant="primary" disabled={!check.ok || state.busy}>
            {editing ? "Save pattern" : "Add pattern"}
          </Button>
        </div>
      </form>
    </DrillSheet>
  );
}

/** Ledger patterns: bank costs, card payments and the like. Admin; writes need a fresh sign-in. */
export function PatternsCard() {
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
        only suggestions unless you allow automatic ledger matches in the thresholds.
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
              </div>
              <div className="stack-row">
                <Button size="sm" aria-label={`Edit ${p.name}`} onClick={() => openSheet(p)}>
                  Edit
                </Button>
                <ConfirmButton
                  label="Delete"
                  ariaLabel={`Delete ${p.name}`}
                  question={`Delete ${p.name}?`}
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
        onClose={() => setSheet(null)}
        onSaved={() => {
          setSheet(null);
          res.reload();
        }}
      />
    </Card>
  );
}
