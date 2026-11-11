import { useMemo, useState } from "react";
import {
  checkScheduleRules,
  describeScheduleRules,
  nextRun,
  validateSchedule,
  type Schedule,
  type ScheduleRules,
} from "@camelthorn/core";
import { Button } from "@camelthorn/ui";

export type PresetKind = "every10" | "hourly" | "daily" | "working" | "lastWorking" | "custom";

export interface Draft {
  kind: PresetKind;
  /** HH:MM, for the daily, working-day and last-working-day presets. */
  time: string;
  expr: string;
  workingDaysOnly: boolean;
}

const PRESETS: { value: PresetKind; label: string }[] = [
  { value: "every10", label: "Every 10 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day at a time" },
  { value: "working", label: "Every working day at a time" },
  { value: "lastWorking", label: "Last working day of the month at a time" },
  { value: "custom", label: "Custom cron expression" },
];

const pad = (n: number): string => String(n).padStart(2, "0");

/** Picks the preset that describes a stored schedule; anything else is "custom". */
export function draftFrom(s: Schedule | null): Draft {
  const base: Draft = { kind: "daily", time: "09:00", expr: "0 9 * * *", workingDaysOnly: false };
  if (s === null) return base;
  if (s.kind === "last_working_day") return { ...base, kind: "lastWorking", time: s.time };
  const wd = s.workingDaysOnly === true;
  const expr = s.expr;
  if (!wd && expr === "*/10 * * * *") return { ...base, kind: "every10", expr };
  if (!wd && expr === "0 * * * *") return { ...base, kind: "hourly", expr };
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expr);
  if (m && Number(m[1]) < 60 && Number(m[2]) < 24) {
    return {
      kind: wd ? "working" : "daily",
      time: `${pad(Number(m[2]))}:${pad(Number(m[1]))}`,
      expr,
      workingDaysOnly: wd,
    };
  }
  return { ...base, kind: "custom", expr, workingDaysOnly: wd };
}

/** The schedule object the draft stands for (not yet validated). */
export function scheduleFrom(d: Draft): unknown {
  const [h, m] = d.time.split(":").map((x) => Number(x));
  const at = `${m} ${h} * * *`;
  switch (d.kind) {
    case "every10":
      return { kind: "cron", expr: "*/10 * * * *" };
    case "hourly":
      return { kind: "cron", expr: "0 * * * *" };
    case "daily":
      return { kind: "cron", expr: at };
    case "working":
      return { kind: "cron", expr: at, workingDaysOnly: true };
    case "lastWorking":
      return { kind: "last_working_day", time: d.time };
    case "custom":
      return {
        kind: "cron",
        expr: d.expr,
        ...(d.workingDaysOnly ? { workingDaysOnly: true } : {}),
      };
  }
}

const fireTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Amsterdam",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "Wed 11 Nov, 02:00" in Amsterdam time. */
export const formatAmsterdam = (ms: number): string => fireTime.format(new Date(ms));

/** The next `count` fire times of a schedule after `fromMs`, in Amsterdam time. */
export function upcoming(s: Schedule, fromMs: number, count = 3): number[] {
  const out: number[] = [];
  let t = fromMs;
  for (let i = 0; i < count; i++) {
    const n = nextRun(s, t);
    if (n === null) break;
    out.push(n);
    t = n;
  }
  return out;
}

export interface EditorValue {
  schedule: Schedule;
  exactBudget: number;
}

/** One sentence on what this job allows, shown under the schedule choice (same text as core). */
export const rulesText = (rules: ScheduleRules | undefined): string => describeScheduleRules(rules);

export function ScheduleEditor({
  initial,
  usesExact,
  budget,
  maxBudget,
  rules,
  busy,
  error,
  nowMs,
  onSave,
  onCancel,
}: {
  initial: Schedule | null;
  usesExact: boolean;
  budget: number;
  maxBudget: number;
  /** What this job's handler allows (from GET /api/jobs); checked live like the server does. */
  rules?: ScheduleRules;
  busy: boolean;
  error: string | null;
  /** The clock the preview counts from (tests pass a fixed one). */
  nowMs: number;
  onSave: (v: EditorValue) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [budgetText, setBudgetText] = useState(String(budget));

  const parsed = useMemo(() => validateSchedule(scheduleFrom(draft)), [draft]);
  const fires = useMemo(() => (parsed.ok ? upcoming(parsed.schedule, nowMs) : []), [parsed, nowMs]);
  const budgetNumber = /^[0-9]{1,5}$/.test(budgetText.trim()) ? Number(budgetText.trim()) : NaN;
  const budgetError = !usesExact
    ? null
    : Number.isInteger(budgetNumber) && budgetNumber >= 1 && budgetNumber <= maxBudget
      ? null
      : `Enter a whole number from 1 to ${maxBudget.toLocaleString("en-US")}.`;
  // packages/core validateSchedule says what is wrong in a sentence ("Invalid minute field: 61").
  const scheduleError = parsed.ok ? null : `This schedule is not valid. ${parsed.error}.`;
  // The same per-handler limits the server enforces (400 schedule_not_allowed), shown as you type.
  const rulesError = useMemo(
    () => (parsed.ok ? checkScheduleRules(parsed.schedule, rules) : null),
    [parsed, rules],
  );
  const showTime =
    draft.kind === "daily" || draft.kind === "working" || draft.kind === "lastWorking";
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!parsed.ok || budgetError !== null || rulesError !== null) return;
        onSave({ schedule: parsed.schedule, exactBudget: usesExact ? budgetNumber : budget });
      }}
    >
      <label className="field">
        When it runs
        <select
          className="input"
          value={draft.kind}
          aria-describedby="rules-help"
          aria-invalid={rulesError !== null}
          onChange={(e) => set({ kind: e.target.value as PresetKind })}
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {showTime && (
        <label className="field">
          Time (Amsterdam)
          <input
            className="input"
            type="time"
            required
            value={draft.time}
            onChange={(e) => set({ time: e.target.value })}
          />
        </label>
      )}
      {draft.kind === "custom" && (
        <>
          <label className="field">
            Cron expression
            <input
              className="input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={draft.expr}
              aria-invalid={scheduleError !== null || rulesError !== null}
              aria-describedby="cron-help rules-help"
              onChange={(e) => set({ expr: e.target.value })}
            />
          </label>
          <p id="cron-help" className="lede">
            Five fields: minute, hour, day of month, month, day of week. For example 15 16 * * *
            runs every day at 16:15. Times are Amsterdam time.
          </p>
          <label className="check-row">
            <input
              className="check"
              type="checkbox"
              checked={draft.workingDaysOnly}
              onChange={(e) => set({ workingDaysOnly: e.target.checked })}
            />
            <span>Working days only (skips weekends and TARGET holidays)</span>
          </label>
        </>
      )}
      {scheduleError !== null && (
        <p role="alert" className="notice warn">
          {scheduleError}
        </p>
      )}
      <p id="rules-help" className="lede">
        {rulesText(rules)}
      </p>
      {rulesError !== null && (
        <p role="alert" className="notice warn">
          {rulesError}
        </p>
      )}
      {parsed.ok && (
        <div aria-live="polite">
          <p className="lede">Next runs, Amsterdam time</p>
          {fires.length === 0 ? (
            <p className="notice warn">This schedule never runs in the next 5 years.</p>
          ) : (
            <ul className="fires">
              {fires.map((t) => (
                <li key={t}>
                  <time dateTime={new Date(t).toISOString()}>{formatAmsterdam(t)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {usesExact && (
        <label className="field">
          Exact calls per administration and run
          <input
            className="input"
            type="text"
            inputMode="numeric"
            value={budgetText}
            aria-invalid={budgetError !== null}
            aria-describedby="budget-help"
            onChange={(e) => setBudgetText(e.target.value)}
          />
        </label>
      )}
      {usesExact && (
        <p id="budget-help" className={budgetError ? "notice warn" : "lede"}>
          {budgetError ??
            `Exact allows 5,000 calls a day per administration. The most you can set is ${maxBudget.toLocaleString("en-US")}.`}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="notice warn">
          {error}
        </p>
      )}
      <div className="chips">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !parsed.ok || budgetError !== null || rulesError !== null}
        >
          Save schedule
        </Button>
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
