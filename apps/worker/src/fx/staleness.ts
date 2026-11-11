/**
 * When is the newest ECB rate stale (CLAUDE.md 3: "alert if the latest rate is older than one
 * working day"; ADR 0036)? The ECB publishes around 16:00 CET on TARGET working days and the
 * import retries until 17:30 Amsterdam, so the rate we EXPECT to hold depends on the clock:
 *
 *  - a TARGET working day, after 17:30: today's rate;
 *  - a TARGET working day, up to and including 17:30: the previous working day's rate;
 *  - a weekend or TARGET holiday: the previous working day's rate.
 *
 * Stale means the newest rate is dated before that expected date. Monday morning with Friday's
 * rate is therefore fine; Tuesday 18:00 with Monday's rate is stale.
 */
import {
  amsterdamParts,
  isTargetWorkingDay,
  previousTargetWorkingDay,
  targetWorkingDaysBetween,
} from "@camelthorn/core";

export const PUBLICATION_DEADLINE_MINUTES = 17 * 60 + 30;

export interface FxStaleness {
  stale: boolean;
  staleReason: "never_imported" | "older_than_one_working_day" | null;
  workingDaysOld: number | null;
}

/** The date of the newest rate that should exist at `nowMs`. */
export function expectedNewestRateDate(nowMs: number): string {
  const { date, hour, minute } = amsterdamParts(nowMs);
  const minutes = hour * 60 + minute;
  if (isTargetWorkingDay(date) && minutes > PUBLICATION_DEADLINE_MINUTES) return date;
  return previousTargetWorkingDay(date);
}

export function fxStaleness(newestRateDate: string | null, nowMs: number): FxStaleness {
  if (newestRateDate === null) {
    return { stale: true, staleReason: "never_imported", workingDaysOld: null };
  }
  const today = amsterdamParts(nowMs).date;
  const stale = newestRateDate < expectedNewestRateDate(nowMs);
  return {
    stale,
    staleReason: stale ? "older_than_one_working_day" : null,
    workingDaysOld: targetWorkingDaysBetween(newestRateDate, today),
  };
}
