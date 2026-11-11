/**
 * Quarantine of Revolut transactions that could not be stored (Phase 5 review S2, ADR 0034).
 *
 * One bad row must not stop the poll or the backfill. A row the client could not map, or the
 * ingest refused (too many legs, a bad leg, a bad amount), is recorded here by id and a fixed code
 * (never the payload) and the page goes on. Quarantined rows are retried one by one with a single
 * read of the transaction (a bounded number of times, then flagged `gave_up`); the walks see them
 * again anyway while they are inside their window. A row that is stored later leaves the table.
 */
import type { RevolutClient } from "@camelthorn/revolut";
import { RevolutApiError } from "@camelthorn/revolut";
import { classifyRevolutError } from "./errors";
import { IngestError } from "./ingest";

export const QUARANTINE_MAX_ATTEMPTS = 5;
/** A quarantined row is retried at most this often. */
export const QUARANTINE_RETRY_MS = 3600_000;
export const QUARANTINE_RETRIES_PER_RUN = 1;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,40}$/;

export interface QuarantineItem {
  id: string | null;
  code: string;
}

/** Records the items. Returns how many were recorded by id and how many had no usable id. */
export async function recordQuarantine(
  db: D1Database,
  connectionId: number,
  items: QuarantineItem[],
  nowIso: string,
): Promise<{ recorded: number; unidentified: number }> {
  let unidentified = 0;
  const statements: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (it.id === null || !ID_RE.test(it.id)) {
      unidentified++;
      continue;
    }
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    statements.push(
      db
        .prepare(
          `INSERT INTO revolut_quarantine (connection_id, external_id, code, first_seen_at, last_seen_at)
           VALUES (?1, ?2, ?3, ?4, ?4)
           ON CONFLICT (connection_id, external_id) DO UPDATE SET
             code = excluded.code, last_seen_at = excluded.last_seen_at`,
        )
        .bind(connectionId, it.id, CODE_RE.test(it.code) ? it.code : "bad_shape", nowIso),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  return { recorded: seen.size, unidentified };
}

/** Removes ids that were stored successfully (one JSON bind: D1 caps bound parameters at 100). */
export async function clearQuarantine(
  db: D1Database,
  connectionId: number,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .prepare(
      `DELETE FROM revolut_quarantine
       WHERE connection_id = ?1 AND external_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(connectionId, JSON.stringify(ids))
    .run();
}

/** Rows still waiting (including those that gave up), for the status field and the summary. */
export async function quarantineCounts(
  db: D1Database,
  connectionId: number,
): Promise<{ open: number; gaveUp: number }> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS open, COALESCE(SUM(gave_up), 0) AS gave_up
       FROM revolut_quarantine WHERE connection_id = ?1`,
    )
    .bind(connectionId)
    .first<{ open: number; gave_up: number }>();
  return { open: r?.open ?? 0, gaveUp: r?.gave_up ?? 0 };
}

export interface RetryOutcome {
  tried: number;
  cleared: number;
  /** Ids that failed again (a bad row, not trouble with Revolut). */
  stillBad: string[];
}

/**
 * Retries up to `limit` quarantined rows with one read each. `store` ingests the transaction (it may
 * throw an IngestError, which counts as a failed attempt). A transaction Revolut no longer has is
 * cleared. A retryable failure stops the loop without counting an attempt.
 */
export async function retryQuarantined(
  db: D1Database,
  client: RevolutClient,
  connectionId: number,
  limit: number,
  nowMs: number,
  signal: AbortSignal,
  skip: ReadonlySet<string>,
  store: (tx: Awaited<ReturnType<RevolutClient["getTransaction"]>>) => Promise<void>,
): Promise<RetryOutcome> {
  const out: RetryOutcome = { tried: 0, cleared: 0, stillBad: [] };
  const nowIso = new Date(nowMs).toISOString();
  const due = new Date(nowMs - QUARANTINE_RETRY_MS).toISOString();
  const rows = (
    await db
      .prepare(
        `SELECT external_id FROM revolut_quarantine
         WHERE connection_id = ?1 AND gave_up = 0 AND attempts < ?3
           AND (last_attempt_at IS NULL OR last_attempt_at <= ?2)
         ORDER BY COALESCE(last_attempt_at, ''), id LIMIT ?4`,
      )
      .bind(connectionId, due, QUARANTINE_MAX_ATTEMPTS, limit + skip.size)
      .all<{ external_id: string }>()
  ).results.filter((r) => !skip.has(r.external_id));
  for (const r of rows.slice(0, limit)) {
    if (signal.aborted) break;
    out.tried++;
    try {
      await store(await client.getTransaction(r.external_id));
      await clearQuarantine(db, connectionId, [r.external_id]);
      out.cleared++;
    } catch (e) {
      const c = classifyRevolutError(e);
      if (c.code === "not_found") {
        await clearQuarantine(db, connectionId, [r.external_id]);
        out.cleared++;
        continue;
      }
      // Only a bad row counts as an attempt; trouble with Revolut or D1 is not the row's fault.
      const badRow = (e instanceof RevolutApiError && e.status === 200) || e instanceof IngestError;
      if (!badRow) break;
      out.stillBad.push(r.external_id);
      await db
        .prepare(
          `UPDATE revolut_quarantine SET attempts = attempts + 1, last_attempt_at = ?3, code = ?4,
             gave_up = CASE WHEN attempts + 1 >= ?5 THEN 1 ELSE gave_up END
           WHERE connection_id = ?1 AND external_id = ?2`,
        )
        .bind(
          connectionId,
          r.external_id,
          nowIso,
          CODE_RE.test(c.code) ? c.code : "bad_shape",
          QUARANTINE_MAX_ATTEMPTS,
        )
        .run();
    }
  }
  return out;
}
