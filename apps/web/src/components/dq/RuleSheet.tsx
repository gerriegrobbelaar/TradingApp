import { useEffect, useMemo, useState } from "react";
import {
  DQ_SEVERITIES,
  dqRuleById,
  isCriticalRule,
  isLooseningChange,
  phraseMatches,
  thresholdValid,
  type DqRuleConfig,
  type DqRuleDto,
  type DqRulePatchRequest,
  type DqSeverity,
} from "@camelthorn/core";
import { Button, Switch } from "@camelthorn/ui";
import { patchDqRule } from "../../api-dq";
import { AREA_LABEL, SEVERITY_LABEL, describeDqError } from "../../lib/dq-labels";
import { useAction } from "../../lib/useAction";
import { DrillSheet } from "../DrillSheet";
import { ErrorLine, StepUpNotice } from "../matching/MatchParts";

const UNIT_LABEL = {
  days: "days",
  minor: "minor units (cents)",
  count: "items",
  factor: "times the interval",
  calls: "Exact calls",
} as const;

const codesText = (v: DqRuleDto["threshold"]): string => (Array.isArray(v) ? v.join(", ") : "");
const parseCodes = (t: string): string[] =>
  t
    .split(/[\s,;]+/)
    .map((c) => c.trim())
    .filter((c) => c !== "");

/**
 * Admin settings of one rule: switch on or off, severity, threshold. Saving needs a fresh Google
 * sign-in (the server asks). Lowering the checks on a CRITICAL rule (switch off, lower severity, a
 * threshold that reports less) needs the confirmation phrase, typed exactly. The server decides
 * again; its refusal shows the phrase field even if this sheet thought none was needed.
 */
export function RuleSheet({
  rule,
  phrase,
  onClose,
  onSaved,
}: {
  rule: DqRuleDto | null;
  phrase: string;
  onClose: () => void;
  onSaved: (rule: DqRuleDto) => void;
}) {
  const [enabled, setEnabled] = useState(true);
  const [severity, setSeverity] = useState<DqSeverity>("warning");
  const [num, setNum] = useState("");
  const [codes, setCodes] = useState("");
  const [typed, setTyped] = useState("");
  const [serverWantsPhrase, setServerWantsPhrase] = useState(false);
  const { state, run, clear } = useAction(describeDqError);
  const id = rule?.id ?? null;
  useEffect(() => {
    if (rule === null) return;
    setEnabled(rule.enabled);
    setSeverity(rule.severity);
    setNum(typeof rule.threshold === "number" ? String(rule.threshold) : "");
    setCodes(codesText(rule.threshold));
    setTyped("");
    setServerWantsPhrase(false);
    clear();
    // Reset only when another rule (or a fresh copy of it) is opened.
  }, [id, rule?.rev, clear]);

  const def = id === null ? undefined : dqRuleById(id);
  const spec = rule?.thresholdSpec ?? null;

  // The threshold the form holds, or "invalid" when it cannot be sent.
  const threshold = useMemo((): number | string[] | null | "invalid" => {
    if (spec === null) return null;
    if (spec.kind === "number") {
      if (!/^\d{1,12}$/.test(num.trim())) return "invalid";
      const n = Number(num.trim());
      return thresholdValid(spec, n) ? n : "invalid";
    }
    const list = parseCodes(codes);
    return thresholdValid(spec, list) ? list : "invalid";
  }, [spec, num, codes]);

  if (rule === null || def === undefined) {
    return (
      <DrillSheet open={false} title="Rule settings" onClose={onClose}>
        {null}
      </DrillSheet>
    );
  }

  const prev: DqRuleConfig = {
    enabled: rule.enabled,
    severity: rule.severity,
    threshold: rule.threshold,
  };
  const next: DqRuleConfig = {
    enabled,
    severity,
    threshold: threshold === "invalid" ? rule.threshold : threshold,
  };
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const thresholdChanged = threshold !== "invalid" && !same(threshold, rule.threshold);
  const changed = enabled !== rule.enabled || severity !== rule.severity || thresholdChanged;
  const loosening = changed && isCriticalRule(prev) && isLooseningChange(def, prev, next);
  const needsPhrase = loosening || serverWantsPhrase;
  const phraseOk = !needsPhrase || phraseMatches(typed, phrase);
  const ready = changed && threshold !== "invalid" && phraseOk;

  async function save() {
    if (!ready || rule === null) return;
    const body: DqRulePatchRequest = { rev: rule.rev };
    if (enabled !== rule.enabled) body.enabled = enabled;
    if (severity !== rule.severity) body.severity = severity;
    if (thresholdChanged && threshold !== null) body.threshold = threshold;
    if (needsPhrase) body.confirm = typed;
    const r = await run(() => patchDqRule(rule.id, body));
    if (r?.ok) onSaved(r.value.rule);
    else if (r && !r.ok) {
      const e = r.error as { code?: string };
      if (e.code === "confirmation_required") setServerWantsPhrase(true);
    }
  }

  return (
    <DrillSheet
      open
      title={rule.title}
      subtitle={`${AREA_LABEL[rule.area]} · ${rule.id}`}
      onClose={onClose}
      dirty={!state.busy && changed}
    >
      <form
        className="dq-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p>{rule.description}</p>
        <Switch label="Check is on" checked={enabled} onCheckedChange={setEnabled} />
        <label className="field">
          Severity
          <select
            className="input"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as DqSeverity)}
          >
            {DQ_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        {spec?.kind === "number" && (
          <label className="field">
            Threshold ({UNIT_LABEL[spec.unit]})
            <input
              className="input"
              inputMode="numeric"
              value={num}
              aria-invalid={threshold === "invalid"}
              aria-describedby="dq-thr-help"
              onChange={(e) => setNum(e.target.value)}
            />
          </label>
        )}
        {spec?.kind === "codes" && (
          <label className="field">
            Ledger account codes
            <input
              className="input"
              value={codes}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={threshold === "invalid"}
              aria-describedby="dq-thr-help"
              onChange={(e) => setCodes(e.target.value)}
            />
          </label>
        )}
        {spec?.kind === "number" && (
          <p id="dq-thr-help" className="cap">
            Between {spec.min} and {spec.max}. Default {spec.default}.
          </p>
        )}
        {spec?.kind === "codes" && (
          <p id="dq-thr-help" className="cap">
            Separate codes with commas. At most {spec.maxItems}, letters, digits, dots and dashes.
          </p>
        )}
        {needsPhrase && (
          <div role="group" aria-labelledby="dq-phrase-h" className="notice warn">
            <p id="dq-phrase-h">
              This rule is critical and the change makes it report less. Type the phrase below to
              confirm.
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
          <Button type="submit" variant="primary" disabled={!ready || state.busy}>
            Save
          </Button>
        </div>
      </form>
    </DrillSheet>
  );
}
