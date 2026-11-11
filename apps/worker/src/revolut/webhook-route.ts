/**
 * POST /api/webhooks/revolut (Phase 5, task R3a; ADR 0033, CLAUDE.md 3 and 5).
 *
 * Public (no cookie), exempt from the CSRF-header rule because every request authenticates itself
 * with an HMAC signature. The order is fixed:
 *   1. size cap (413 before reading, and while reading when there is no Content-Length);
 *   2. raw BYTES of the body (never text()), the connection's signing secrets (current, previous);
 *   3. R1 `verifyRevolutWebhook` BEFORE anything parses the body. EVERY failure (no connection,
 *      no secret, missing header, bad timestamp, out of window, bad signature) is the same plain
 *      401: fixed body, fixed headers, no reason. The reason code goes to the log, never the body
 *      or the headers;
 *   4. SHA-256 of the raw body into webhook_events (UNIQUE connection + hash): a duplicate
 *      delivery (Revolut retries) answers 200 without enqueueing again;
 *   5. only now parse; store type and transaction id; send ONE queue message with ids only; 200.
 *      If the queue refuses, the row is marked error and the answer is 500, so Revolut retries and
 *      the retry (same body, same hash) re-enqueues.
 * Unknown event types are 200 and `ignored`. Event processing is in events.ts (the queue consumer);
 * nothing here calls Revolut.
 */
import {
  MAX_WEBHOOK_BODY_BYTES,
  parseWebhookEvent,
  verifyRevolutWebhook,
} from "@camelthorn/revolut";
import type { Env } from "../env";
import type { RevolutEventMessage } from "../jobs/types";
import { json, type Ctx, type Router } from "../router";
import { REVOLUT_WEBHOOK_PATH } from "./config";
import { loadRevolutConnection, loadWebhookSecretSet, retirePreviousWebhookSecret } from "./store";

/** Revolut's own limit, the verifier's limit and ours are the same number. */
export const MAX_BODY_BYTES = MAX_WEBHOOK_BODY_BYTES;
/** A queued row nobody processed for this long is re-enqueued by a redelivery. */
export const REQUEUE_AFTER_MS = 5 * 60_000;
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

/** The body as bytes, or null when it is larger than the cap (cancelling the stream early). */
async function readBody(request: Request): Promise<ArrayBuffer | null> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    /^\d{1,12}$/.test(declared.trim()) &&
    Number(declared) <= MAX_BODY_BYTES
  ) {
    const buf = await request.arrayBuffer();
    return buf.byteLength > MAX_BODY_BYTES ? null : buf;
  }
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
async function enqueueEvent(
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

interface EventRow {
  id: number;
  status: string;
  error_code: string | null;
  event_type: string;
  received_at: string;
}

async function webhook(ctx: Ctx): Promise<Response> {
  const { env, request } = ctx;
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    /^\d{1,15}$/.test(declared.trim()) &&
    Number(declared) > MAX_BODY_BYTES
  ) {
    return tooLarge();
  }
  const body = await readBody(request);
  if (body === null) return tooLarge();

  const reject = (reason: string): Response => {
    // The reason only, no body, no headers, no signature (CLAUDE.md 5).
    console.warn("revolut webhook rejected", reason);
    return unauthorized();
  };

  const conn = await loadRevolutConnection(env.DB);
  if (!conn || conn.status !== "active") return reject("no_active_connection");
  let secrets: { current: string | null; previous: string | null };
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

  // Rotation: the new secret verified, so the overlap with the previous one is over.
  if (verifiedWith.current && secrets.previous !== null) {
    await retirePreviousWebhookSecret(env.DB, conn.id).catch(() => undefined);
  }

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
        `SELECT id, status, error_code, event_type, received_at FROM webhook_events
         WHERE connection_id = ?1 AND event_hash = ?2`,
      )
      .bind(conn.id, hash)
      .first<EventRow>();
    if (!row) return json({ ok: true });
    rowId = row.id;
    const nowIso = new Date(ctx.nowMs).toISOString();
    if (row.status === "error" && row.error_code === "enqueue_failed") {
      const claimed = await db
        .prepare(
          `UPDATE webhook_events SET status = 'queued', error_code = NULL, received_at = ?2
           WHERE id = ?1 AND status = 'error' AND error_code = 'enqueue_failed'`,
        )
        .bind(row.id, nowIso)
        .run();
      if (claimed.meta.changes !== 1) return json({ ok: true });
    } else if (row.status === "queued" && row.event_type === UNPARSED) {
      // Never parsed (the first delivery died between the insert and the parse): handle again.
    } else if (row.status === "queued") {
      const cut = new Date(ctx.nowMs - REQUEUE_AFTER_MS).toISOString();
      const claimed = await db
        .prepare(
          `UPDATE webhook_events SET received_at = ?2
           WHERE id = ?1 AND status = 'queued' AND received_at < ?3`,
        )
        .bind(row.id, nowIso, cut)
        .run();
      if (claimed.meta.changes !== 1) return json({ ok: true });
    } else {
      return json({ ok: true });
    }
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
