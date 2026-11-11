/**
 * Per-handler limits on what an admin may schedule (review S3). Pure, shared by the Worker (which
 * enforces them in PATCH /api/jobs) and the Schedules screen (which shows them live).
 */
import { analyseSchedule, type Schedule } from "./schedule";

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

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The sentence that says why a schedule is refused, or null if it is allowed. */
export function checkScheduleRules(s: Schedule, rules: ScheduleRules | undefined): string | null {
  const min = Math.max(rules?.minIntervalMinutes ?? 0, GLOBAL_MIN_INTERVAL_MINUTES);
  if (rules?.workingDaysOnly === true && !(s.kind === "cron" && s.workingDaysOnly === true)) {
    return "This job only runs on working days. Switch on working days only.";
  }
  const a = analyseSchedule(s);
  if (a === null) return null; // validateSchedule reports invalid schedules
  if (a.minGapMinutes !== null && a.minGapMinutes < min) {
    return `This job cannot run more often than every ${fmt(min)} minutes. This schedule runs every ${fmt(a.minGapMinutes)}.`;
  }
  const allowed = rules?.allowedIntervalMinutes;
  if (allowed) {
    const [lo, hi] = allowed;
    if (a.minGapMinutes === null || a.maxGapMinutes === null) {
      return `This job must run every ${lo} to ${hi} minutes, all day.`;
    }
    if (a.minGapMinutes < lo || a.maxGapMinutes > hi) {
      return `This job must run every ${lo} to ${hi} minutes, all day. This schedule has gaps of ${fmt(a.minGapMinutes)} to ${fmt(a.maxGapMinutes)} minutes.`;
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
