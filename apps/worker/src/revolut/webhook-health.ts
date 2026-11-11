/**
 * Health of the Revolut webhook channel (Phase 5 review S4, ADR 0033).
 *
 * The webhook route is public, so everything it records must be cheap and bounded no matter how
 * many unauthenticated requests arrive:
 *  - rejected deliveries are counted per (connection, UTC minute, reason code) in
 *    webhook_rejections with an upsert, and a per-isolate limiter allows at most ONE such write
 *    per reason per minute (the counts in between are carried in memory and added to the next
 *    write). The reason is mapped to a closed list, so the table cannot grow with attacker input.
 *    Under a flood the stored count is therefore a lower bound; a restarted isolate loses the
 *    unwritten remainder. The signal that matters (was anything rejected, and when) is exact.
 *  - verified deliveries stamp connections.last_webhook_verified_at at most once per minute.
 * No body, header, signature, address or secret is stored or logged.
 */
import type { Env } from "../env";

/** Closed list: anything else is stored as 'other'. */
export const REJECT_REASONS = [
  "missing_header",
  "bad_timestamp",
  "timestamp_out_of_range",
  "malformed",
  "bad_signature",
  "no_accepting_connection",
  "connection_unreadable",
  "secret_unreadable",
  "no_secret",
  "bad_secret",
  "other",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** How often one isolate may write one reason / the verified stamp. */
export const HEALTH_WRITE_EVERY_MS = 60_000;
/** Rejections older than this are deleted by housekeepWebhookEvents. */
export const REJECTION_RETENTION_DAYS = 7;

export const normalizeReason = (reason: string): RejectReason =>
  (REJECT_REASONS as readonly string[]).includes(reason) ? (reason as RejectReason) : "other";

interface Carry {
  /** Rejections seen since the last write (this one included). */
  pending: number;
  /** When this isolate last wrote this reason (ms). */
  lastWriteMs: number;
}
const carry = new Map<RejectReason, Carry>();
const verifiedWrites = new Map<number, number>();

/** Test hook: forget what this isolate has written. */
export function resetWebhookHealthState(): void {
  carry.clear();
  verifiedWrites.clear();
  logWindowStart = 0;
  logCount = 0;
}

const minuteStart = (ms: number): string =>
  new Date(Math.floor(ms / 60_000) * 60_000).toISOString();

/**
 * Counts a rejected delivery. Never throws and never reads D1. Most calls only touch memory.
 */
export async function recordRejection(
  env: Pick<Env, "DB">,
  nowMs: number,
  rawReason: string,
): Promise<void> {
  const reason = normalizeReason(rawReason);
  const c = carry.get(reason) ?? { pending: 0, lastWriteMs: Number.NEGATIVE_INFINITY };
  c.pending += 1;
  carry.set(reason, c);
  // Written at most once per window (and again after a clock that went backwards).
  const since = nowMs - c.lastWriteMs;
  if (since >= 0 && since < HEALTH_WRITE_EVERY_MS) return;
  const n = c.pending;
  c.pending = 0;
  c.lastWriteMs = nowMs;
  try {
    await env.DB.batch([
      // v1 has one Revolut connection; no row, nothing to count.
      env.DB.prepare(
        `INSERT INTO webhook_rejections (connection_id, bucket_at, reason_code, count)
         SELECT id, ?1, ?2, ?3 FROM connections WHERE kind = 'revolut' ORDER BY id LIMIT 1
         ON CONFLICT (connection_id, bucket_at, reason_code) DO UPDATE SET count = count + ?3`,
      ).bind(minuteStart(nowMs), reason, n),
      env.DB.prepare(
        `UPDATE connections
         SET last_webhook_rejected_at = ?1, webhook_rejected_total = webhook_rejected_total + ?2
         WHERE kind = 'revolut'`,
      ).bind(new Date(nowMs).toISOString(), n),
    ]);
  } catch {
    // Keep the count for the next write; never fail a request over a counter.
    c.pending += n;
  }
}

/** Stamps a verified delivery, at most once a minute per isolate (and per row in D1). */
export async function recordVerified(
  env: Pick<Env, "DB">,
  connectionId: number,
  nowMs: number,
): Promise<void> {
  const last = verifiedWrites.get(connectionId);
  if (last !== undefined && nowMs >= last && nowMs - last < HEALTH_WRITE_EVERY_MS) return;
  verifiedWrites.set(connectionId, nowMs);
  try {
    await env.DB.prepare(
      `UPDATE connections SET last_webhook_verified_at = ?2
       WHERE id = ?1 AND kind = 'revolut'
         AND (last_webhook_verified_at IS NULL OR last_webhook_verified_at < ?3
              OR last_webhook_verified_at > ?2)`,
    )
      .bind(
        connectionId,
        new Date(nowMs).toISOString(),
        new Date(nowMs - HEALTH_WRITE_EVERY_MS).toISOString(),
      )
      .run();
  } catch {
    verifiedWrites.delete(connectionId);
  }
}

// ---- sampled logging ------------------------------------------------------------------------

/** At most this many rejection log lines per minute per isolate (the rest are counted, not logged). */
export const MAX_REJECT_LOGS_PER_MINUTE = 10;
let logWindowStart = 0;
let logCount = 0;

/** Logs the reason code only, sampled so unauthenticated callers cannot flood the log. */
export function logRejection(nowMs: number, reason: string): void {
  if (nowMs - logWindowStart >= 60_000 || nowMs < logWindowStart) {
    logWindowStart = nowMs;
    logCount = 0;
  }
  logCount += 1;
  if (logCount <= MAX_REJECT_LOGS_PER_MINUTE) {
    console.warn("revolut webhook rejected", reason);
  } else if (logCount === MAX_REJECT_LOGS_PER_MINUTE + 1) {
    console.warn("revolut webhook rejections: further lines suppressed this minute");
  }
}

// ---- reading --------------------------------------------------------------------------------

/** Rejected deliveries in the last 24 hours (the bucketed counts; a lower bound under a flood). */
export async function rejectedLast24h(
  db: D1Database,
  connectionId: number,
  nowMs: number,
): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(count), 0) AS n FROM webhook_rejections
       WHERE connection_id = ?1 AND bucket_at >= ?2`,
    )
    .bind(connectionId, minuteStart(nowMs - 24 * 3_600_000))
    .first<{ n: number }>();
  return r?.n ?? 0;
}
