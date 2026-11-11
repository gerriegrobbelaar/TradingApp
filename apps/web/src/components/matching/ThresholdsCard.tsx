import { useMemo, useState } from "react";
import type { MatchConfigResponse } from "@camelthorn/core";
import { Button, Card } from "@camelthorn/ui";
import { putMatchConfig } from "../../api-matching";
import {
  LIST_FIELDS,
  NUMBER_FIELDS,
  checkTunables,
  toForm,
  type TunablesForm,
} from "../../lib/matching-settings";
import { useAction } from "../../lib/useAction";
import { useToast } from "../../toasts";
import { ErrorLine, StepUpNotice } from "./MatchParts";

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

  async function save() {
    if (!check.ok) return;
    const r = await run(() => putMatchConfig({ config: check.value }));
    if (r?.ok) {
      toast.show("Saved the matching thresholds.");
      onSaved();
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
    </Card>
  );
}
