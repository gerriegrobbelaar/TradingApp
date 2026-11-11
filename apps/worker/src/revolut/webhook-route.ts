/**
 * POST /api/webhooks/revolut (Phase 5, task R3a; ADR 0033, CLAUDE.md 3 and 5).
 *
 * Public (no cookie), exempt from the CSRF-header rule because every request authenticates itself
 * with an HMAC signature. The order is fixed:
 *   0. the cheap header checks (both headers present, timestamp 13 digits and inside the 5-minute
 *      window, signature header well formed): a failure answers the uniform 401 BEFORE the body is
 *      read and without touching D1 reads (review N1). The rejection is counted by a throttled,
 *      bucketed write (webhook-health.ts), never one row per request;
 *   1. size cap (413 when Content-Length is too large; the body is always read as a counted
 *      stream and cancelled past the cap, whatever Content-Length says);
 *   2. raw BYTES of the body (never text()), the connection's signing secrets (current, previous);
 *   3. R1 `verifyRevolutWebhook` BEFORE anything parses the body. EVERY failure (no connection,
 *      a pending or disabled connection, no secret, a database or decryption error while loading
 *      them, missing header, bad timestamp, out of window, bad signature) is the same plain 401:
 *      fixed body, fixed headers, no reason. The reason code goes to the log, never the body or
 *      the headers. Connections in active, needs_reauth or expired accept signed deliveries;
 *   4. SHA-256 of the raw body (bytes only, not the timestamp header) into webhook_events (UNIQUE
 *      connection + hash): Revolut's retry of a delivery re-signs the same body with a new
 *      timestamp, and is the same event. A duplicate answers 200 without enqueueing again, except
 *      a row that never reached the queue or sat in it unprocessed (bounded by MAX_REQUEUES);
 *   5. only now parse; store type and transaction id; send ONE queue message with ids only; 200.
 *      If the queue refuses, the row is marked error and the answer is 500, so Revolut retries and
 *      the retry (same body, same hash) re-enqueues.
 * Unknown event types are 200 and `ignored`. Event processing is in events.ts (the queue consumer);
 * nothing here calls Revolut.
 */
import {
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_SIGNATURES,
  parseWebhookEvent,
  verifyRevolutWebhook,
} from "@camelthorn/revolut";
import type { Env } from "../env";
import type { RevolutEventMessage } from "../jobs/types";
import { json, type Ctx, type Router } from "../router";
import { REVOLUT_WEBHOOK_PATH } from "./config";
import {
  loadRevolutConnection,
  loadWebhookSecretSet,
  reencryptWebhookSecrets,
  retirePreviousWebhookSecret,
} from "./store";
import { logRejection, recordRejection, recordVerified } from "./webhook-health";

/** Revolut's own limit, the verifier's limit and ours are the same number. */
export const MAX_BODY_BYTES = MAX_WEBHOOK_BODY_BYTES;
/** A queued row nobody processed for this long is re-enqueued by a redelivery. */
export const REQUEUE_AFTER_MS = 5 * 60_000;
/**
 * A row still `unparsed` (the first delivery died between the insert and the parse) is only taken
 * over by a redelivery older than this, so two overlapping deliveries of one body cannot both
 * enqueue it (review N2).
 */
export const UNPARSED_CLAIM_AFTER_MS = 60_000;
const TIMESTAMP_RE = /^\d{13}$/;
const SIGNATURE_V1_RE = /^v1=[0-9a-fA-F]{64}$/;
const WINDOW_MS = 300_000;
/**
 * How often repeated deliveries may re-enqueue one row (enqueue_failed, never parsed, or stale
 * queued). Revolut retries 3 more times; a replay of a captured delivery inside the 5-minute
 * timestamp window is bounded by this too. Past it the answer is 200 and the poll / backfill
 * pick the transaction up.
 */
export const MAX_REQUEUES = 5;
/**
 * Connection states whose correctly signed deliveries are accepted (recorded and enqueued). A
 * connection that needs re-authorisation keeps its subscription and secrets: the event is
 * recorded, its processing ends as `error` with the status as code, and the backfill after
 * re-authorisation recovers the transaction. pending / disabled / none: the uniform 401.
 */
const ACCEPTING: readonly string[] = ["active", "needs_reauth", "expired"];
/** event_type of a row whose body has not been parsed yet. */
export const UNPARSED = "unparsed";
/** Same alphabet the gate accepts for /transaction/{id}. */
const TX_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const EVENT_NAME_RE = /^[A-Za-z]{1,40}$/;

/** Identical for every authentication failure: nothing in it depends on the cause. */
function unauthorized(): Response {
  return new Response("unauthorized", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const tooLarge = (): Response => json({ error: "payload_too_large" }, 413);

/**
 * The body as bytes, or null when it is larger than the cap. Always read as a stream with a
 * running count, whatever Content-Length says (absent, or lying), and cancelled as soon as the
 * count passes the cap: an oversized body is never buffered whole.
 */
async function readBody(request: Request): Promise<ArrayBuffer | null> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

async function sha256HexBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sends the one queue message for a webhook row. False (never throws) when the queue refuses. */
export async function enqueueEvent(
  env: Pick<Env, "JOBS_QUEUE">,
  webhookEventId: number,
): Promise<boolean> {
  try {
    const msg: RevolutEventMessage = { type: "revolut_event", webhookEventId };
    await env.JOBS_QUEUE.send(msg);
    return true;
  } catch {
    console.error("revolut webhook enqueue failed");
    return false;
  }
}

/**
 * The header checks R1's verifier makes first, repeated here so a bad request is refused before
 * the body is read or D1 is asked anything. Returns R1's reason code, or null when the headers
 * look usable (the signature itself is checked later). Must stay in step with the verifier: it
 * may never refuse something the verifier would accept.
 */
export function precheckHeaders(request: Request, nowMs: number): string | null {
  const signature = request.headers.get("revolut-signature");
  const timestamp = request.headers.get("revolut-request-timestamp");
  if (
    signature === null ||
    signature.trim() === "" ||
    timestamp === null ||
    timestamp.trim() === ""
  ) {
    return "missing_header";
  }
  const ts = timestamp.trim();
  if (!TIMESTAMP_RE.test(ts)) return "bad_timestamp";
  if (Math.abs(nowMs - Number(ts)) > WINDOW_MS) return "timestamp_out_of_range";
  const parts = signature.split(",");
  if (parts.length > MAX_WEBHOOK_SIGNATURES) return "malformed";
  if (!parts.some((p) => SIGNATURE_V1_RE.test(p.trim()))) return "malformed";
  return null;
}

interface EventRow {
  id: number;
  status: string;
  error_code: string | null;
  event_type: string;
}

async function webhook(ctx: Ctx): Promise<Response> {
  const { env, request } = ctx;
  const reject = async (reason: string): Promise<Response> => {
    // The reason code only, no body, no headers, no signature (CLAUDE.md 5). Logged sampled and
    // counted through a throttled bucketed write: an unauthenticated caller cannot flood either.
    logRejection(ctx.nowMs, reason);
    await recordRejection(env, ctx.nowMs, reason).catch(() => undefined);
    return unauthorized();
  };

  const early = precheckHeaders(request, ctx.nowMs);
  if (early !== null) return reject(early);

  const declared = request.headers.get("content-length");
  // Declared too large: refuse before reading anything (any digit string longer than the cap's).
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_BODY_BYTES) {
    return tooLarge();
  }
  const body = await readBody(request);
  if (body === null) return tooLarge();

  // Everything before the signature check answers the same 401, including a database or
  // decryption error: an unauthenticated caller must not be able to tell the causes apart.
  let conn: Awaited<ReturnType<typeof loadRevolutConnection>>;
  try {
    conn = await loadRevolutConnection(env.DB);
  } catch {
    return reject("connection_unreadable");
  }
  if (!conn || !ACCEPTING.includes(conn.status)) return reject("no_accepting_connection");
  let secrets: { current: string | null; previous: string | null; stale: boolean };
  try {
    secrets = await loadWebhookSecretSet(env, conn.id);
  } catch {
    return reject("secret_unreadable");
  }
  const candidates: { secret: string; current: boolean }[] = [];
  if (secrets.current && secrets.current.trim() !== "") {
    candidates.push({ secret: secrets.current, current: true });
  }
  if (secrets.previous && secrets.previous.trim() !== "") {
    candidates.push({ secret: secrets.previous, current: false });
  }
  if (candidates.length === 0) return reject("no_secret");

  let verifiedWith: { current: boolean } | null = null;
  let lastReason = "bad_signature";
  for (const c of candidates) {
    try {
      const v = await verifyRevolutWebhook({
        rawBody: body,
        signatureHeader: request.headers.get("revolut-signature"),
        timestampHeader: request.headers.get("revolut-request-timestamp"),
        signingSecret: c.secret,
        nowMs: ctx.nowMs,
      });
      if (v.ok) {
        verifiedWith = c;
        break;
      }
      lastReason = v.reason;
      // Header and timestamp problems do not depend on the secret: no point in trying the next.
      if (v.reason !== "bad_signature") break;
    } catch {
      lastReason = "bad_secret";
    }
  }
  if (verifiedWith === null) return reject(lastReason);

  await recordVerified(env, conn.id, ctx.nowMs);

  // Rotation: the new secret verified, so the overlap with the previous one is over.
  if (verifiedWith.current && secrets.previous !== null) {
    await retirePreviousWebhookSecret(env.DB, conn.id).catch(() => undefined);
  }
  // A secret still under the previous TOKEN_ENC_KEY is moved to the current key now (review S3).
  if (secrets.stale) await reencryptWebhookSecrets(env, conn.id);

  const hash = await sha256HexBytes(body);
  const db = env.DB;
  const ins = await db
    .prepare(
      `INSERT INTO webhook_events (connection_id, event_hash, event_type, status)
       VALUES (?1, ?2, '${UNPARSED}', 'queued')
       ON CONFLICT (connection_id, event_hash) DO NOTHING`,
    )
    .bind(conn.id, hash)
    .run();
  let rowId: number;
  if (ins.meta.changes === 1) {
    rowId = ins.meta.last_row_id;
  } else {
    // A repeated delivery. Only a row that never reached the queue, or sat there unprocessed for a
    // long time, is queued again; everything else is answered 200 and ignored.
    const row = await db
      .prepare(
        `SELECT id, status, error_code, event_type FROM webhook_events
         WHERE connection_id = ?1 AND event_hash = ?2`,
      )
      .bind(conn.id, hash)
      .first<EventRow>();
    if (!row) return json({ ok: true });
    rowId = row.id;
    const nowIso = new Date(ctx.nowMs).toISOString();
    // Each re-enqueue is claimed atomically and counted (MAX_REQUEUES), so concurrent or replayed
    // deliveries cannot loop a row through the queue.
    const claim = (condition: string, ...binds: string[]) =>
      db
        .prepare(
          `UPDATE webhook_events
           SET status = 'queued', error_code = NULL, received_at = ?2,
               requeue_count = requeue_count + 1
           WHERE id = ?1 AND requeue_count < ${MAX_REQUEUES} AND ${condition}`,
        )
        .bind(row.id, nowIso, ...binds)
        .run();
    let claimed: D1Result | null = null;
    if (row.status === "error" && row.error_code === "enqueue_failed") {
      claimed = await claim("status = 'error' AND error_code = 'enqueue_failed'");
    } else if (row.status === "queued" && row.event_type === UNPARSED) {
      // Never parsed (the first delivery died between the insert and the parse): handle again.
      const cutUnparsed = new Date(ctx.nowMs - UNPARSED_CLAIM_AFTER_MS).toISOString();
      claimed = await claim(
        `status = 'queued' AND event_type = '${UNPARSED}' AND received_at < ?3`,
        cutUnparsed,
      );
    } else if (row.status === "queued") {
      const cut = new Date(ctx.nowMs - REQUEUE_AFTER_MS).toISOString();
      claimed = await claim("status = 'queued' AND received_at < ?3", cut);
    }
    // Processed, ignored, error, recently queued, or out of re-enqueues: a no-op.
    if (claimed === null || claimed.meta.changes !== 1) return json({ ok: true });
  }

  // Signature is valid: now (and only now) look inside.
  const parsed = parseWebhookEvent(body);
  const finish = (status: "ignored" | "error", type: string, code: string | null) =>
    db
      .prepare(
        `UPDATE webhook_events SET status = ?2, event_type = ?3, error_code = ?4, processed_at = ?5
         WHERE id = ?1 AND status = 'queued'`,
      )
      .bind(rowId, status, type, code, new Date(ctx.nowMs).toISOString())
      .run();
  if (!parsed.ok) {
    await finish("error", "invalid", "bad_payload");
    return json({ ok: true });
  }
  if (parsed.event.event === "unknown") {
    const name = parsed.event.name;
    await finish(
      "ignored",
      name !== undefined && EVENT_NAME_RE.test(name) ? name : "unknown",
      null,
    );
    return json({ ok: true });
  }
  const txId = parsed.event.data.id;
  if (!TX_ID_RE.test(txId)) {
    await finish("error", parsed.event.event, "bad_transaction_id");
    return json({ ok: true });
  }
  await db
    .prepare("UPDATE webhook_events SET event_type = ?2, external_id = ?3 WHERE id = ?1")
    .bind(rowId, parsed.event.event, txId)
    .run();

  if (!(await enqueueEvent(env, rowId))) {
    await db
      .prepare(
        `UPDATE webhook_events SET status = 'error', error_code = 'enqueue_failed'
         WHERE id = ?1 AND status = 'queued'`,
      )
      .bind(rowId)
      .run();
    return json({ error: "try_again" }, 500);
  }
  return json({ ok: true });
}

export function registerRevolutWebhookRoute(router: Router): void {
  router.add("POST", REVOLUT_WEBHOOK_PATH, { public: true, csrfExempt: true }, webhook);
}
