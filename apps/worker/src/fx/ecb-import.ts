/**
 * The ECB import job `ecb.fx_import` (CLAUDE.md 3 and 4.5, ADR 0036; handler contract ADR 0021).
 *
 *  - Rates are stored as decimal strings in `fx_rates` (units of currency per 1 EUR), one row per
 *    currency and ECB date. Published ECB rates are final, so a stored row is never overwritten:
 *    INSERT ... ON CONFLICT DO NOTHING. If the ECB later shows a different value for a stored
 *    (currency, date), the stored one stays, `conflicts` counts it and an `fx.rate_conflict`
 *    audit row records both values (public data, no secrets) once.
 *  - The first import reads the last 400 days; later runs read from 10 days back, or from 3 days
 *    before the newest stored date if that is older (so a long outage fills its gap).
 *  - A scheduled run on a TARGET working day succeeds when the slot day's rate is stored. If it is
 *    not published yet the run is `partial` / `not_yet_published` and asks for a retry in 10
 *    minutes. Whether a retry still fits is decided from the SLOT (16:15) + lateness (75 min =
 *    17:30) and the clock at the moment of deciding, with a margin for queue delay: the next
 *    attempt must start by 17:30 even if the queue delivers it a few minutes late. When it would
 *    not, the run ends `error` / `rate_not_published` (Phase 8 alerts on it). Should the queue be
 *    later still, the runner records `error` / `too_late` (handler `tooLateIsFailure`), and
 *    `onTooLate` writes that into fx_import_state. Manual runs refresh and backfill whenever.
 *  - Transient failures (network, timeout, 429, 5xx) retry the same way; a response that cannot be
 *    trusted (redirect, wrong content type, too large, not parseable) is an `error` without retry.
 */
import {
  addDaysIso,
  amsterdamParts,
  isTargetWorkingDay,
  parseEcbCsv,
  parseRate,
  ecbRequestUrl,
  type EcbObservation,
} from "@camelthorn/core";
import { auditStatement } from "../db/audit";
import { scheduledDate, scheduledForMs } from "../jobs/period";
import type { HandlerResult, JobContext } from "../jobs/types";
import type { Env } from "../env";
import { fetchEcb } from "./ecb-fetch";

export const ECB_MAX_ATTEMPTS = 8;
/** 16:15 + 75 minutes = 17:30. */
export const ECB_MAX_LATENESS_MS = 75 * 60_000;
export const ECB_RETRY_SECONDS = 600;
/**
 * Room left between "the retry is due" and 17:30 for queue delivery delay and the wind-down of
 * this attempt (D1 writes). Measured queue delays are 0 to 2 minutes; 3 leaves one spare.
 */
export const ECB_RETRY_MARGIN_MS = 3 * 60_000;
export const FIRST_IMPORT_DAYS = 400;
export const INCREMENTAL_DAYS = 10;
/** Back from the newest stored date, so a publication that came after 17:30 is picked up later. */
export const OVERLAP_DAYS = 3;
/** Rows per INSERT (each INSERT is one atomic statement). */
export const INSERT_CHUNK = 100;
const MAX_CONFLICT_AUDITS = 25;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface UpsertResult {
  inserted: number;
  conflicts: number;
  skipped: number;
}

/** The canonical form of a stored rate (parseRate output), or the raw text if it does not parse. */
const canonical = (r: string): string => {
  const p = parseRate(r);
  return p.ok ? p.rate : r;
};

/**
 * Stores observations idempotently; returns counts. Exported for tests.
 *
 * Rates are normalised by core `parseRate` BEFORE they are compared or stored, so "1.10", "1.1"
 * and "1.1000" are one value. Rows go in oldest first in INSERTs of at most 100 rows; each INSERT
 * is atomic, so a failure part-way leaves a complete prefix and the next run (whose window starts
 * before the newest stored date) inserts the rest.
 */
export async function storeObservations(
  db: D1Database,
  observations: EcbObservation[],
  since: string,
  today: string,
  nowIso: string,
): Promise<UpsertResult> {
  const stored = new Map<string, string>();
  const existing = await db
    .prepare("SELECT currency, rate_date, rate FROM fx_rates WHERE rate_date >= ?1")
    .bind(since)
    .all<{ currency: string; rate_date: string; rate: string }>();
  for (const r of existing.results) stored.set(`${r.currency}|${r.rate_date}`, r.rate);

  const fresh: [string, string, string][] = [];
  const seen = new Set<string>();
  const conflictRows: { currency: string; date: string; stored: string; ecb: string }[] = [];
  let skipped = 0;
  let conflicts = 0;
  for (const o of observations) {
    const rate = parseRate(o.rate);
    const valid =
      /^[A-Z]{3}$/.test(o.currency) &&
      o.currency !== "EUR" &&
      ISO.test(o.rateDate) &&
      o.rateDate <= today;
    const key = `${o.currency}|${o.rateDate}`;
    if (!valid || !rate.ok || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const have = stored.get(key);
    if (have === undefined) fresh.push([o.currency, o.rateDate, rate.rate]);
    else if (canonical(have) !== rate.rate) {
      conflicts++;
      conflictRows.push({
        currency: o.currency,
        date: o.rateDate,
        stored: canonical(have),
        ecb: rate.rate,
      });
    }
  }
  fresh.sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : 1));

  let inserted = 0;
  for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
    const chunk = fresh.slice(i, i + INSERT_CHUNK);
    const res = await db
      .prepare(
        `INSERT INTO fx_rates (currency, rate_date, rate, source, fetched_at)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                json_extract(value, '$[2]'), 'ECB', ?2
         FROM json_each(?1) WHERE 1
         ON CONFLICT (currency, rate_date) DO NOTHING`,
      )
      .bind(JSON.stringify(chunk), nowIso)
      .run();
    inserted += res.meta.changes ?? 0;
  }

  if (conflictRows.length > 0) await auditConflicts(db, conflictRows);
  return { inserted, conflicts, skipped };
}

/**
 * One `fx.rate_conflict` row per (currency, date, stored value, ECB value), ever. Disagreements
 * already audited are filtered out BEFORE the per-run cap, so a long list is worked through over
 * successive runs instead of the same first 25 being retried forever. The NOT EXISTS guard keeps
 * two concurrent runs from writing the same row twice.
 */
async function auditConflicts(
  db: D1Database,
  rows: { currency: string; date: string; stored: string; ecb: string }[],
): Promise<void> {
  const entityIds = [...new Set(rows.map((c) => `${c.currency}@${c.date}`))];
  const done = new Set<string>();
  for (let i = 0; i < entityIds.length; i += INSERT_CHUNK) {
    const known = await db
      .prepare(
        `SELECT entity_id, after_json FROM audit_log
         WHERE entity = 'fx_rate' AND entity_id IN (SELECT value FROM json_each(?1))
           AND action = 'fx.rate_conflict'`,
      )
      .bind(JSON.stringify(entityIds.slice(i, i + INSERT_CHUNK)))
      .all<{ entity_id: string; after_json: string | null }>();
    for (const k of known.results) done.add(`${k.entity_id}|${k.after_json ?? ""}`);
  }
  const todo = rows
    .map((c) => ({ id: `${c.currency}@${c.date}`, after: { stored: c.stored, ecb: c.ecb } }))
    .filter((c) => !done.has(`${c.id}|${JSON.stringify(c.after)}`))
    .slice(0, MAX_CONFLICT_AUDITS);
  if (todo.length === 0) return;
  await db.batch(
    todo.map((c) =>
      auditStatement(
        db,
        {
          actorEmail: "system",
          action: "fx.rate_conflict",
          entity: "fx_rate",
          entityId: c.id,
          after: c.after,
        },
        {
          sql: `NOT EXISTS (SELECT 1 FROM audit_log WHERE entity = 'fx_rate' AND entity_id = ?7
                  AND action = 'fx.rate_conflict' AND after_json = ?8)`,
          binds: [c.id, JSON.stringify(c.after)],
        },
      ),
    ),
  );
}

async function importWindow(
  db: D1Database,
  today: string,
): Promise<{ start: string; first: boolean }> {
  const newest = await db
    .prepare("SELECT MAX(rate_date) AS d FROM fx_rates")
    .first<{ d: string | null }>();
  const floor = addDaysIso(today, -FIRST_IMPORT_DAYS);
  if (newest?.d == null) return { start: floor, first: true };
  const a = addDaysIso(today, -INCREMENTAL_DAYS);
  const b = addDaysIso(newest.d > today ? today : newest.d, -OVERLAP_DAYS);
  const start = a < b ? a : b;
  return { start: start < floor ? floor : start, first: false };
}

interface StateWrite {
  nowIso: string;
  status: "ok" | "partial" | "error" | "skipped";
  code: string | null;
  inserted: number;
  success: boolean;
}

function stateStatement(db: D1Database, s: StateWrite): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO fx_import_state (id, last_attempt_at, last_success_at, last_status,
                                    last_error_code, newest_rate_date, rows_inserted)
       VALUES (1, ?1, ?2, ?3, ?4, (SELECT MAX(rate_date) FROM fx_rates), ?5)
       ON CONFLICT (id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = COALESCE(excluded.last_success_at, fx_import_state.last_success_at),
         last_status = excluded.last_status,
         last_error_code = excluded.last_error_code,
         newest_rate_date = excluded.newest_rate_date,
         rows_inserted = excluded.rows_inserted`,
    )
    .bind(s.nowIso, s.success ? s.nowIso : null, s.status, s.code, s.inserted);
}

/**
 * The runner's `onTooLate` hook: the attempt never reached the handler because the queue
 * delivered it after 17:30. fx_import_state says so (status error, code too_late).
 */
export async function recordEcbTooLate(env: Env, nowMs: number): Promise<void> {
  await stateStatement(env.DB, {
    nowIso: new Date(nowMs).toISOString(),
    status: "error",
    code: "too_late",
    inserted: 0,
    success: false,
  }).run();
}

async function finishWith(
  ctx: JobContext,
  result: HandlerResult,
  extra: { inserted?: number; conflicts?: number } = {},
): Promise<HandlerResult> {
  const db = ctx.env.DB;
  const nowIso = new Date(ctx.now()).toISOString();
  const inserted = extra.inserted ?? 0;
  const statements = [
    stateStatement(db, {
      nowIso,
      status: result.status,
      code: result.code ?? null,
      inserted,
      success: result.status === "ok",
    }),
  ];
  const expectedWait = result.code === "not_yet_published" || result.code === "already_current";
  const noteworthy =
    inserted > 0 ||
    (extra.conflicts ?? 0) > 0 ||
    result.status === "error" ||
    (result.status === "partial" && !expectedWait);
  if (noteworthy && result.code !== "already_current") {
    statements.push(
      auditStatement(db, {
        actorEmail: "system",
        action: "fx.import",
        entity: "fx_rates",
        after: { status: result.status, code: result.code ?? null, ...result.summary },
      }),
    );
  }
  await db.batch(statements);
  return result;
}

/** Number of currencies on the newest stored date before `today` (what a full day looks like). */
async function expectedCurrencies(db: D1Database, today: string): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM fx_rates
       WHERE rate_date = (SELECT MAX(rate_date) FROM fx_rates WHERE rate_date < ?1)`,
    )
    .bind(today)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function currenciesOn(db: D1Database, date: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM fx_rates WHERE rate_date = ?1")
    .bind(date)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** True when the text has anything after its header line (a CSV whose rows were all refused). */
function hasDataRows(text: string): boolean {
  const t = text.trim();
  const nl = t.search(/[\r\n]/);
  return nl >= 0 && t.slice(nl).trim() !== "";
}

/**
 * Can this scheduled attempt ask for another one, `delaySeconds` from now? Decided from the
 * slot (16:15) + lateness (17:30) and the clock NOW, not from the attempt number: the next attempt
 * must be due by 17:30 minus the queue-delay margin. Attempts are capped too.
 */
export function retryFits(ctx: JobContext, delaySeconds: number): boolean {
  return (
    ctx.trigger !== "manual" &&
    ctx.run.attempt < ECB_MAX_ATTEMPTS &&
    ctx.now() + delaySeconds * 1000 + ECB_RETRY_MARGIN_MS <=
      scheduledForMs(ctx) + ECB_MAX_LATENESS_MS
  );
}

export async function runEcbImport(ctx: JobContext): Promise<HandlerResult> {
  try {
    return await importOnce(ctx);
  } catch (e) {
    // A crash (D1 failure, abort) still leaves a truthful state row; the runner records the run.
    await stateStatement(ctx.env.DB, {
      nowIso: new Date(ctx.now()).toISOString(),
      status: "error",
      code: ctx.signal.aborted ? "aborted" : "handler_error",
      inserted: 0,
      success: false,
    })
      .run()
      .catch(() => undefined);
    throw e;
  }
}

async function importOnce(ctx: JobContext): Promise<HandlerResult> {
  const db = ctx.env.DB;
  const scheduled = ctx.trigger !== "manual";
  const slotDate = scheduledDate(ctx);
  const today = amsterdamParts(ctx.now()).date;

  if (scheduled && !isTargetWorkingDay(slotDate)) {
    return finishWith(ctx, { status: "skipped", code: "non_working_day", summary: {} });
  }

  if (scheduled) {
    const have = await currenciesOn(db, slotDate);
    if (have > 0 && have >= (await expectedCurrencies(db, slotDate))) {
      return finishWith(ctx, {
        status: "ok",
        code: "already_current",
        summary: { currencies: have },
      });
    }
  }

  const { start, first } = await importWindow(db, today);
  const url = ecbRequestUrl({ startDate: start });
  const fetched = await fetchEcb(url, ctx.signal, ctx.now);

  const fail = (code: string, summary: Record<string, string | number> = {}) =>
    finishWith(ctx, { status: "error", code, summary });

  if (fetched.kind === "transient") {
    const summary: Record<string, number> = {};
    if (fetched.status !== undefined) summary["httpStatus"] = fetched.status;
    const delay = Math.max(ECB_RETRY_SECONDS, fetched.retryAfterSeconds ?? 0);
    if (fetched.retryAfterSeconds !== undefined) summary["retryAfterSeconds"] = delay;
    if (retryFits(ctx, delay)) {
      return finishWith(ctx, {
        status: "partial",
        code: fetched.code,
        summary,
        retry: { delaySeconds: delay },
      });
    }
    return finishWith(ctx, { status: "error", code: fetched.code, summary });
  }
  if (fetched.kind === "permanent") {
    return fail(fetched.code, fetched.status === undefined ? {} : { httpStatus: fetched.status });
  }

  let observations: EcbObservation[] = [];
  let parseSkipped = 0;
  if (!fetched.empty) {
    const parsed = parseEcbCsv(fetched.text);
    if (parsed.ok) {
      observations = parsed.observations;
      parseSkipped = parsed.skipped;
    } else if (parsed.error !== "no_observations" || hasDataRows(fetched.text)) {
      // A header-only CSV is "nothing in the window"; rows that were all refused, a wrong header,
      // an unclosed quote or an oversize body are not data we can trust.
      return fail("bad_response", { parseError: parsed.error });
    }
  }

  const nowIso = new Date(ctx.now()).toISOString();
  const res = await storeObservations(db, observations, start, today, nowIso);
  const todayCount = await currenciesOn(db, slotDate);
  const expected = await expectedCurrencies(db, slotDate);
  const summary = {
    firstImport: first,
    windowDays: Math.round((Date.parse(today) - Date.parse(start)) / 86_400_000),
    received: observations.length,
    inserted: res.inserted,
    conflicts: res.conflicts,
    skipped: res.skipped + parseSkipped,
    currenciesToday: todayCount,
    ...(todayCount > 0 && todayCount < expected ? { missingToday: expected - todayCount } : {}),
  };
  const extra = { inserted: res.inserted, conflicts: res.conflicts };

  if (!scheduled || todayCount > 0) {
    return finishWith(ctx, { status: "ok", summary }, extra);
  }
  if (retryFits(ctx, ECB_RETRY_SECONDS)) {
    return finishWith(
      ctx,
      {
        status: "partial",
        code: "not_yet_published",
        summary,
        retry: { delaySeconds: ECB_RETRY_SECONDS },
      },
      extra,
    );
  }
  return finishWith(ctx, { status: "error", code: "rate_not_published", summary }, extra);
}
