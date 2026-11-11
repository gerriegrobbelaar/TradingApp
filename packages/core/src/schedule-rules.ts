/**
 * Per-handler limits on what an admin may schedule (review S3). Pure, shared by the Worker (which
 * enforces them in PATCH /api/jobs) and the Schedules screen (which shows them live).
 */
import { analyseSchedule, validateSchedule, type Schedule } from "./schedule";

export interface ScheduleRules {
  /** No two fires closer than this many minutes (never below GLOBAL_MIN_INTERVAL_MINUTES). */
  minIntervalMinutes?: number;
  /** The job must fire continuously, with every gap inside [min, max] minutes. */
  allowedIntervalMinutes?: readonly [number, number];
  /** The schedule must be a cron with `workingDaysOnly` (TARGET working days). */
  workingDaysOnly?: boolean;
}

/** Nothing runs every minute: 5 minutes is the floor for every job. */
export const GLOBAL_MIN_INTERVAL_MINUTES = 5;
/** Projected Exact calls per administration and day that all enabled Exact jobs may add up to. */
export const MAX_PROJECTED_EXACT_CALLS_PER_DAY = 3000;

/** "5 minutes", "1.5 minutes", "hour", "2 hours", "day": the interval after the word "every". */
export function formatInterval(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0)
    return minutes === 1440 ? "day" : `${minutes / 1440} days`;
  if (minutes > 0 && minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  const n = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
  return `${n} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** The handler's own minimum, never below the global floor. */
export const effectiveMinInterval = (rules: ScheduleRules | undefined): number =>
  Math.max(rules?.minIntervalMinutes ?? 0, GLOBAL_MIN_INTERVAL_MINUTES);

/**
 * What this job allows, as the sentence the Schedules editor shows under the schedule. Built from
 * the same rules checkScheduleRules enforces, so the help text and the server cannot disagree.
 */
export function describeScheduleRules(rules: ScheduleRules | undefined): string {
  const parts: string[] = [];
  const allowed = rules?.allowedIntervalMinutes;
  if (allowed) {
    parts.push(`It must run every ${allowed[0]} to ${allowed[1]} minutes, all day.`);
  } else {
    parts.push(
      `It cannot run more often than every ${formatInterval(effectiveMinInterval(rules))}.`,
    );
  }
  if (rules?.workingDaysOnly === true) parts.push("It runs on working days only.");
  return parts.join(" ");
}

/** The sentence that says why a schedule is refused, or null if it is allowed. */
export function checkScheduleRules(s: Schedule, rules: ScheduleRules | undefined): string | null {
  const min = effectiveMinInterval(rules);
  if (rules?.workingDaysOnly === true && !(s.kind === "cron" && s.workingDaysOnly === true)) {
    return "This job only runs on working days. Switch on working days only.";
  }
  // An invalid schedule is validateSchedule's to report (with its own sentence).
  if (!validateSchedule(s).ok) return null;
  const a = analyseSchedule(s);
  // Valid but no fire in the analysis window: its load cannot be bounded, so it is refused rather
  // than counted as zero Exact calls. (Every valid cron fires within the four-year window; this is
  // a guard, not a rule people meet.)
  if (a === null) {
    return "This schedule runs too rarely to check. Choose one that runs at least once a year.";
  }
  if (a.minGapMinutes !== null && a.minGapMinutes < min) {
    return `This job cannot run more often than every ${formatInterval(min)}. This schedule runs ${formatInterval(a.minGapMinutes)} apart at its closest.`;
  }
  const allowed = rules?.allowedIntervalMinutes;
  if (allowed) {
    const [lo, hi] = allowed;
    if (a.minGapMinutes === null || a.maxGapMinutes === null) {
      return `This job must run every ${lo} to ${hi} minutes, all day.`;
    }
    if (a.minGapMinutes < lo || a.maxGapMinutes > hi) {
      return `This job must run every ${lo} to ${hi} minutes, all day. This schedule has gaps of ${formatInterval(a.minGapMinutes)} to ${formatInterval(a.maxGapMinutes)}.`;
    }
  }
  return null;
}

export interface ExactJobLoad {
  schedule: Schedule;
  /** Exact calls per administration and run (jobs.exact_budget). */
  budget: number;
  /** Runs per slot including retries (the handler's maxAttempts). */
  maxAttempts: number;
}

/** Worst case Exact calls per administration and Amsterdam day: fires x budget x attempts, summed. */
export function projectedExactCalls(jobs: readonly ExactJobLoad[]): number {
  let total = 0;
  for (const j of jobs) {
    const a = analyseSchedule(j.schedule);
    total += (a?.maxFiresPerDay ?? 0) * j.budget * j.maxAttempts;
  }
  return total;
}
