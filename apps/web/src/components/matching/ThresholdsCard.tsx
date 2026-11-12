import { useMemo, useState } from "react";
import {
  AUTO_MATCH_CONFIRM_PHRASE,
  type MatchConfigResponse,
  type MatchTunablesDto,
} from "@camelthorn/core";
import { ApiError } from "../../api";
import { Button, Card } from "@camelthorn/ui";
import { putMatchConfig } from "../../api-matching";
import {
  LIST_FIELDS,
  NUMBER_FIELDS,
  checkTunables,
  toForm,
  tunablesLoosen,
  type TunablesForm,
} from "../../lib/matching-settings";
import { useAction } from "../../lib/useAction";
import { useToast } from "../../toasts";
import { ErrorLine, StepUpNotice } from "./MatchParts";
import { TypedPhraseSheet } from "./TypedPhraseSheet";

/** The tunable thresholds, checked live with the same rules the server and the engine use. */
export function ThresholdsCard({
  config,
  onSaved,
}: {
  config: MatchConfigResponse;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<TunablesForm>(() => toForm(config.config));
  const { state, run } = useAction();
  const saved = useMemo(() => JSON.stringify(toForm(config.config)), [config.config]);
  const dirty = JSON.stringify(form) !== saved;
  const check = useMemo(() => checkTunables(form), [form]);
  const [asking, setAsking] = useState<MatchTunablesDto | null>(null);
  const phrase = config.autoConfirmPhrase || AUTO_MATCH_CONFIRM_PHRASE;
  // The revision this form was built from: a save over somebody else's change answers 409.
  const rev = "rev" in config ? { rev: config.rev ?? null } : {};
  const loosens = check.ok && config.autoEnabled && tunablesLoosen(config.config, check.value);

  function saved_() {
    toast.show("Saved the matching thresholds.");
    onSaved();
  }

  async function save() {
    if (!check.ok) return;
    // While automatic matching is on, a change that lets it do more needs the phrase again.
    if (loosens) {
      setAsking(check.value);
      return;
    }
    const value = check.value;
    const r = await run(() => putMatchConfig({ config: value, ...rev }));
    if (r?.ok) saved_();
    else if (
      r &&
      !r.ok &&
      r.error instanceof ApiError &&
      r.error.status === 422 &&
      r.error.code === "confirmation_required"
    ) {
      // The server judged it loosening after all (its rule is authoritative): ask for the phrase.
      setAsking(value);
    }
  }

  return (
    <Card>
      <h2 className="h2">Matching thresholds</h2>
      <p className="lede">
        How sure the engine must be before it matches a line automatically, and how many suggestions
        it keeps. Changes apply from the next matching run.
      </p>
      {config.configErrors.length > 0 && (
        <div role="alert" className="notice warn">
          <p>
            The stored settings are not valid, so matching does not run until they are fixed.
            Correct the values below and save.
          </p>
        </div>
      )}
      <form
        className="mt-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {NUMBER_FIELDS.map((f) => {
          const err = check.ok ? undefined : check.fields[f.key];
          return (
            <label key={f.key} className="field">
              {f.label}
              <input
                className="input num"
                inputMode="numeric"
                autoComplete="off"
                value={form.numbers[f.key]}
                aria-invalid={err ? true : undefined}
                aria-describedby={`th-${f.key}-hint`}
                onChange={(e) =>
                  setForm({ ...form, numbers: { ...form.numbers, [f.key]: e.target.value } })
                }
              />
              <span id={`th-${f.key}-hint`} className={err ? "cap bad" : "cap"}>
                {err ?? f.hint}
              </span>
            </label>
          );
        })}
        {LIST_FIELDS.map((f) => {
          const err = check.ok ? undefined : check.fields[f.key];
          return (
            <label key={f.key} className="field">
              {f.label}
              <input
                className="input"
                autoComplete="off"
                spellCheck={false}
                value={form.lists[f.key]}
                aria-invalid={err ? true : undefined}
                aria-describedby={`th-${f.key}-hint`}
                onChange={(e) =>
                  setForm({ ...form, lists: { ...form.lists, [f.key]: e.target.value } })
                }
              />
              <span id={`th-${f.key}-hint`} className={err ? "cap bad" : "cap"}>
                {err ?? f.hint}
              </span>
            </label>
          );
        })}
        <label className="choice">
          <input
            type="checkbox"
            checked={form.autoIncomingUnknownIban}
            onChange={(e) => setForm({ ...form, autoIncomingUnknownIban: e.target.checked })}
          />
          <span>
            Let incoming payments from an unknown account be matched automatically (loosens
            automatic matching)
            <span className="hint">
              Off by default. When off, money in from an account that is not on file for the
              customer always goes to review.
            </span>
          </span>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={form.autoLedgerPatterns}
            onChange={(e) => setForm({ ...form, autoLedgerPatterns: e.target.checked })}
          />
          <span>
            Let ledger patterns be matched automatically
            <span className="hint">
              Off by default. A pattern can book a line to a ledger account without a person.
            </span>
          </span>
        </label>
        {!check.ok && dirty && (
          <ul role="alert" className="notice warn mt-problems">
            {check.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {loosens && dirty && (
          <p role="note" className="notice warn">
            Automatic matching is on and this change lets it do more, so saving asks you to type the
            confirmation again.
          </p>
        )}
        {state.needsStepUp && <StepUpNotice />}
        {state.error && <ErrorLine>{state.error}</ErrorLine>}
        <div className="stack-row">
          <Button type="submit" variant="primary" disabled={!dirty || !check.ok || state.busy}>
            Save thresholds
          </Button>
          <Button disabled={state.busy} onClick={() => setForm(toForm(config.defaults))}>
            Fill in the defaults
          </Button>
        </div>
      </form>
      <TypedPhraseSheet
        open={asking !== null}
        title="Confirm looser automatic matching"
        phrase={phrase}
        confirmLabel="Save thresholds"
        intro={
          <p>
            Automatic matching is on. This change lets it match more lines without a person (a lower
            score or gap, more tolerance, fewer days after an account change, more payment types, or
            unknown incoming accounts). It needs a Google sign-in from the last 15 minutes.
          </p>
        }
        onClose={() => setAsking(null)}
        onConfirm={({ phrase: typed }) =>
          asking
            ? putMatchConfig({ config: asking, confirm: typed, ...rev })
            : Promise.reject(new Error("nothing to save"))
        }
        onDone={() => {
          setAsking(null);
          saved_();
        }}
      />
    </Card>
  );
}
