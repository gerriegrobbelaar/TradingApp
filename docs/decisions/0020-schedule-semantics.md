# 0020 — Schedule semantics (DST, catch-up, TARGET calendar, horizon)

Status: accepted (Phase 3, task H1). Code: `packages/core/src/schedule.ts`,
`packages/core/src/target-calendar.ts`.

## Schedule kinds

- `{ kind: "cron", expr, workingDaysOnly? }` — standard 5-field cron (minute hour day-of-month
  month day-of-week), evaluated in **Europe/Amsterdam** local time. Lists, ranges, steps
  (`*/10`, `1-30/5`, `5/15`), month names (`jan`) and day names (`mon`) are supported; day-of-week
  0 and 7 are Sunday. When both day-of-month and day-of-week are restricted (first character not
  `*`), either may match (Vixie cron rule); otherwise both must.
- `workingDaysOnly: true` additionally requires the Amsterdam date to be a TARGET working day.
  The ECB import is `15 16 * * *` with `workingDaysOnly` ("Working days at 16:15").
- `{ kind: "last_working_day", time: "HH:mm" }` — the last TARGET working day of each month
  (FX revaluation at 16:30).

`validateSchedule` rejects expressions longer than 200 characters, malformed fields, impossible
dates (31 February) and any schedule that has no fire within 5 years of 2025-01-01 (for example
25 December on working days only). Parsing is linear in the input with no backtracking regexes.

## DST rule

Decided by the hour field only:

| Hour field | Spring forward (02:00-02:59 missing) | Fall back (02:00-02:59 twice) |
|---|---|---|
| wildcard (`*`, `*/1`, `0-23`) | no fires in the missing hour; every other real mark fires | every real mark fires, so the repeated hour fires twice |
| restricted (`2`, `*/2`, `1-3`, last_working_day) | a wall time in the gap fires **once at 03:00** | a wall time in the repeated hour fires **once**, at the first (summer time) occurrence |

So an hourly job (`0 * * * *`) fires 23 times on the spring day and 25 times on the autumn day,
always one real hour apart, and `*/10` stays exactly 10 real minutes apart. A daily or monthly job
at 02:30 never fires twice and is never skipped. The builder's first version fired hourly jobs
only once in the repeated hour (a 2-hour gap) while `0,30 * * * *` fired twice; the reviewer
replaced this with the rule above because it depends on one field only and needs no exceptions.

## Catch-up rule (`isDue`)

`isDue(s, lastRunMs, nowMs, createdMs)` is true when a fire exists in
`(lastRunMs ?? createdMs, nowMs]`. The caller runs the job once and records `lastRunMs = now`, so
after any outage the job runs **once**, never once per missed slot. The slot it runs for (`dueSlot`, shared by
`isDue` and the scheduler tick) is the **latest** missed fire, not the oldest (J1 review): a
handler's lateness limit and the period it derives from the slot then refer to the newest missed
slot, so an hourly job back after a 3-hour outage runs for the last hour instead of being skipped
as too late, and a month-end job caught up days later books the month that just ended. A never-run job counts from
`createdMs` (created at 16:20 with a 16:15 schedule: first run tomorrow).

Clock going backwards: if the reference is up to one day in the future the job waits for the first
fire after it (no second run of a slot already done). A reference more than one day in the future
is treated as corrupt: the job runs on its normal schedule (a fire in the minute ending at
`nowMs`) instead of stalling for good; recording `lastRunMs = now` restores normal behaviour.

## TARGET calendar

Closing days: Saturday, Sunday, 1 January, Good Friday, Easter Monday, 1 May, 25 December and
26 December. Easter is computed with the anonymous Gregorian algorithm (tested against Oudin's
algorithm for 2000-2100 and a list of known dates), so no yearly table is needed. If the ECB
changes the TARGET calendar this file must change. `targetWorkingDaysBetween(from, to)` counts
working days in `(from, to]`; the FX staleness alert fires when the latest rate is more than one
working day old.

## Horizon and purity

`nextRun` searches at most 5 x 366 days ahead and returns `null` beyond that (or for invalid
input, non-finite instants, or instants outside 1970-9000). Worst case (a schedule that never
fires) is about 1,830 cheap day checks, well under 50 ms; typical calls take microseconds. The
module has no I/O and never reads the clock: callers pass `now`.
