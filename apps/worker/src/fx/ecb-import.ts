/**
 * The ECB import job `ecb.fx_import` (CLAUDE.md 3 and 4.5, ADR 0035; handler contract ADR 0021).
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
 *    minutes; the last retry that still fits before slot + lateness (17:30) ends `error` /
 *    `rate_not_published`, which Phase 8 alerts on. Manual runs refresh and backfill whenever.
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
import { fetchEcb } from "./ecb-fetch";

export const ECB_MAX_ATTEMPTS = 8;
/** 16:15 + 75 minutes = 17:30. */
export const ECB_MAX_LATENESS_MS = 75 * 60_000;
export const ECB_RETRY_SECONDS = 600;
export const FIRST_IMPORT_DAYS = 400;
export const INCREMENTAL_DAYS = 10;
const CHUNK = 100;
const MAX_CONFLICT_AUDITS = 25;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const canon = (r: string): string =>
  r.includes(".") ? r.replace(/0+$/, "").replace(/\.$/, "") : r;

export interface UpsertResult {
  inserted: number;
  conflicts: number;
  skipped: number;
}

/** Stores observations idempotently; returns counts. Exported for tests. */
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
    const valid =
      /^[A-Z]{3}$/.test(o.currency) &&
      o.currency !== "EUR" &&
      ISO.test(o.rateDate) &&
      o.rateDate <= today &&
      parseRate(o.rate).ok;
    const key = `${o.currency}|${o.rateDate}`;
    if (!valid || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const have = stored.get(key);
    if (have === undefined) fresh.push([o.currency, o.rateDate, o.rate]);
    else if (canon(have) !== canon(o.rate)) {
      conflicts++;
      conflictRows.push({ currency: o.currency, date: o.rateDate, stored: have, ecb: o.rate });
    }
  }

  let inserted = 0;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const chunk = fresh.slice(i, i + CHUNK);
    const res = await db.batch([
      db
        .prepare(
          `INSERT INTO fx_rates (currency, rate_date, rate, source, fetched_at)
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                  json_extract(value, '$[2]'), 'ECB', ?2
           FROM json_each(?1) WHERE 1
           ON CONFLICT (currency, rate_date) DO NOTHING`,
        )
        .bind(JSON.stringify(chunk), nowIso),
    ]);
    inserted += res[0]?.meta.changes ?? 0;
  }

  if (conflictRows.length > 0) {
    await db.batch(
      conflictRows.slice(0, MAX_CONFLICT_AUDITS).map((c) => {
        const after = { stored: c.stored, ecb: c.ecb };
        return auditStatement(
          db,
          {
            actorEmail: "system",
            action: "fx.rate_conflict",
            entity: "fx_rate",
            entityId: `${c.currency}@${c.date}`,
            after,
          },
          // Once per (currency, date, new value): the same disagreement is not audited daily.
          {
            sql: `NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'fx.rate_conflict'
                    AND entity_id = ?7 AND after_json = ?8)`,
            binds: [`${c.currency}@${c.date}`, JSON.stringify(after)],
          },
        );
      }),
    );
  }
  return { inserted, conflicts, skipped };
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
  const start = [
    addDaysIso(today, -INCREMENTAL_DAYS),
    addDaysIso(newest.d, -3),
  ].sort()[0] as string;
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

export async function runEcbImport(ctx: JobContext): Promise<HandlerResult> {
  const db = ctx.env.DB;
  const scheduled = ctx.trigger !== "manual";
  const nowMs = ctx.now();
  const slotDate = scheduledDate(ctx);
  const today = amsterdamParts(nowMs).date;

  if (scheduled && !isTargetWorkingDay(slotDate)) {
    return finishWith(ctx, { status: "skipped", code: "non_working_day", summary: {} });
  }

  // A retry fits when the next attempt would still start before slot + 75 minutes (17:30).
  const canRetry =
    scheduled &&
    ctx.run.attempt < ECB_MAX_ATTEMPTS &&
    nowMs + ECB_RETRY_SECONDS * 1000 <= scheduledForMs(ctx) + ECB_MAX_LATENESS_MS;

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
  const fetched = await fetchEcb(url, ctx.signal);

  const fail = (code: string, status?: number): Promise<HandlerResult> =>
    finishWith(ctx, {
      status: "error",
      code,
      summary: status === undefined ? {} : { httpStatus: status },
    });

  if (fetched.kind === "transient") {
    const summary = fetched.status === undefined ? {} : { httpStatus: fetched.status };
    if (canRetry) {
      return finishWith(ctx, {
        status: "partial",
        code: fetched.code,
        summary,
        retry: { delaySeconds: ECB_RETRY_SECONDS },
      });
    }
    return finishWith(ctx, { status: "error", code: fetched.code, summary });
  }
  if (fetched.kind === "permanent") return fail(fetched.code, fetched.status);

  let observations: EcbObservation[] = [];
  let parseSkipped = 0;
  if (!fetched.empty) {
    const parsed = parseEcbCsv(fetched.text);
    if (!parsed.ok) return fail("bad_response");
    if (parsed.observations.length === 0 && parsed.skipped > 0) return fail("bad_response");
    observations = parsed.observations;
    parseSkipped = parsed.skipped;
  }

  const nowIso = new Date(nowMs).toISOString();
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

  if (!scheduled || todayCount > 0 || !isTargetWorkingDay(slotDate)) {
    return finishWith(ctx, { status: "ok", summary }, extra);
  }
  if (canRetry) {
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
