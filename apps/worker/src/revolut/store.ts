/**
 * D1 access for the Revolut connection row. Tokens and webhook signing secrets are encrypted
 * before they reach this layer (crypto/token-crypto.ts); the row types here never carry plaintext.
 * v1 has exactly one Revolut connection (kind 'revolut', name 'revolut'); see ADR 0031.
 */
import { auditStatement } from "../db/audit";
import {
  decryptToken,
  encryptToken,
  isEncryptedWith,
  isUnreadableValue,
  keyring,
} from "../crypto/token-crypto";
import type { ConnectionStatus } from "../exact/store";
import { isRevolutEnvironment, type RevolutEnvironment } from "./config";

export type { ConnectionStatus };

export const REVOLUT_CONNECTION_NAME = "revolut";

export interface RevolutConnectionRow {
  id: number;
  status: ConnectionStatus;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string | null;
  last_error: string | null;
  revolut_environment: string | null;
  creates_bank_entries: number;
  payments_mode: "drafts" | "pay";
  bank_entries_decided_at: string | null;
  webhook_id: string | null;
  connected_by: string | null;
  connected_at: string | null;
  /** Staged connection (status 'pending'): when it expires, its confirm ref, who staged it. */
  pending_until: string | null;
  pending_ref: string | null;
  pending_by: string | null;
  /** JSON of a PendingSummary (masked facts only), or null while not inspected yet. */
  pending_summary: string | null;
}

const COLUMNS = `id, status, access_token_enc, refresh_token_enc, expires_at, last_error,
  revolut_environment, creates_bank_entries, payments_mode, bank_entries_decided_at, webhook_id,
  connected_by, connected_at, pending_until, pending_ref, pending_by, pending_summary`;

/** A staged connection must be confirmed within this long, else its tokens are wiped. */
export const PENDING_TTL_MS = 15 * 60_000;
/** last_error of a connection whose staged tokens expired unconfirmed. */
export const PENDING_EXPIRED = "pending_expired";

/**
 * What the admin is shown before confirming a staged connection. Masked facts only: never a full
 * IBAN, a balance amount or a Revolut id. Stored as JSON in pending_summary.
 */
export interface PendingSummary {
  accountCount: number;
  currencies: string[];
  /** Account holder names Revolut reports in the bank details (the business name). */
  holders: string[];
  accounts: { name: string; currency: string; state: string; last4: string | null }[];
  /** Accounts this connection had before (bank_accounts rows) and how many of them came back. */
  previousAccounts: number;
  matchingAccounts: number;
  /** False when Revolut's redirect carried no `state` (the flow was bound by the cookie only). */
  stateEchoed: boolean;
}

const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Parses a stored summary; null when absent or not the expected shape. */
export function parsePendingSummary(raw: string | null): PendingSummary | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingSummary>;
    if (
      !v ||
      typeof v !== "object" ||
      !Number.isSafeInteger(v.accountCount) ||
      !isStrArr(v.currencies) ||
      !isStrArr(v.holders) ||
      !Array.isArray(v.accounts) ||
      !Number.isSafeInteger(v.previousAccounts) ||
      !Number.isSafeInteger(v.matchingAccounts) ||
      typeof v.stateEchoed !== "boolean"
    ) {
      return null;
    }
    return v as PendingSummary;
  } catch {
    return null;
  }
}

/** A staged row whose confirmation window is still open. */
export function isLivePending(
  row: Pick<RevolutConnectionRow, "status" | "pending_until">,
  nowMs: number,
): boolean {
  if (row.status !== "pending" || row.pending_until === null) return false;
  const until = Date.parse(row.pending_until);
  return Number.isFinite(until) && until > nowMs;
}

/**
 * Wipes the tokens of a staged connection nobody confirmed in time (status 'disabled',
 * last_error 'pending_expired'), in one batch with its audit row (ADR 0013). A 'pending' row
 * without an expiry (left over by an interrupted callback) counts as expired. Returns true if it
 * changed anything. Called lazily (connections list, start, confirm) and by the gate.
 */
export async function expireRevolutPending(db: D1Database, nowMs: number): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString();
  const stale = `kind = 'revolut' AND status = 'pending' AND (pending_until IS NULL OR pending_until <= ?1)`;
  const row = await db
    .prepare(`SELECT id, pending_by FROM connections WHERE ${stale} ORDER BY id LIMIT 1`)
    .bind(nowIso)
    .first<{ id: number; pending_by: string | null }>();
  if (!row) return false;
  const results = await db.batch([
    auditStatement(
      db,
      {
        actorEmail: "system",
        action: "connection.revolut_pending_expired",
        entity: "connection",
        entityId: row.id,
        before: { status: "pending", stagedBy: row.pending_by },
        after: { status: "disabled", reason: PENDING_EXPIRED },
      },
      {
        sql: `EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND ${stale.replace("?1", "?8")})`,
        binds: [row.id, nowIso],
      },
    ),
    db
      .prepare(
        `UPDATE connections
         SET status = 'disabled', last_error = '${PENDING_EXPIRED}', access_token_enc = NULL,
             refresh_token_enc = NULL, token_ref = NULL, expires_at = NULL, pending_until = NULL,
             pending_ref = NULL, pending_by = NULL, pending_summary = NULL, updated_at = ?1
         WHERE id = ?2 AND ${stale}`,
      )
      .bind(nowIso, row.id),
  ]);
  return (results[1]?.meta.changes ?? 0) === 1;
}

export const loadRevolutConnection = (db: D1Database): Promise<RevolutConnectionRow | null> =>
  db
    .prepare(`SELECT ${COLUMNS} FROM connections WHERE kind = 'revolut' ORDER BY id LIMIT 1`)
    .first<RevolutConnectionRow>();

export const loadRevolutById = (db: D1Database, id: number): Promise<RevolutConnectionRow | null> =>
  db
    .prepare(`SELECT ${COLUMNS} FROM connections WHERE kind = 'revolut' AND id = ?1`)
    .bind(id)
    .first<RevolutConnectionRow>();

/** The environment of a row, or null when the column is empty/corrupt (callers then refuse). */
export const environmentOf = (row: {
  revolut_environment: string | null;
}): RevolutEnvironment | null =>
  isRevolutEnvironment(row.revolut_environment) ? row.revolut_environment : null;

export type SecretKind = "access" | "refresh" | "webhook_secret" | "webhook_secret_prev";

/** AAD that binds each ciphertext to its connection and column. */
export const aad = (connectionId: number, kind: SecretKind): string =>
  `revolut:${connectionId}:${kind}`;

/**
 * Marks an active connection as needing a person to re-authorise and wipes its tokens, in one
 * batch with the audit row (ADR 0013). The webhook subscription and its secrets stay: incoming
 * events must still verify, and a re-authorisation keeps the subscription. Returns true if it
 * changed anything.
 */
export async function markNeedsReauth(
  db: D1Database,
  connectionId: number,
  reason: string,
): Promise<boolean> {
  const results = await db.batch([
    auditStatement(
      db,
      {
        actorEmail: "system",
        action: "connection.revolut_needs_reauth",
        entity: "connection",
        entityId: connectionId,
        before: { status: "active" },
        after: { status: "needs_reauth", reason },
      },
      {
        sql: "EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND kind = 'revolut' AND status = 'active')",
        binds: [connectionId],
      },
    ),
    db
      .prepare(
        `UPDATE connections
         SET status = 'needs_reauth', last_error = ?2, access_token_enc = NULL,
             refresh_token_enc = NULL, token_ref = NULL, expires_at = NULL,
             refresh_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND kind = 'revolut' AND status = 'active'`,
      )
      .bind(connectionId, reason),
  ]);
  return (results[1]?.meta.changes ?? 0) === 1;
}

/**
 * Stores the webhook subscription id and its signing secret (returned once by Revolut when the
 * subscription is created, task R3). The previous secret is kept for the rotation overlap.
 */
export async function saveWebhookSecret(
  env: { DB: D1Database; TOKEN_ENC_KEY: string; TOKEN_ENC_KEY_PREVIOUS?: string },
  connectionId: number,
  webhookId: string,
  signingSecret: string,
  actorEmail: string,
): Promise<void> {
  const current = await env.DB.prepare(
    "SELECT webhook_secret_enc FROM connections WHERE id = ?1 AND kind = 'revolut'",
  )
    .bind(connectionId)
    .first<{ webhook_secret_enc: string | null }>();
  if (!current) throw new Error("no revolut connection");
  const enc = await encryptToken(
    env.TOKEN_ENC_KEY,
    signingSecret,
    aad(connectionId, "webhook_secret"),
  );
  // The previous ciphertext is bound to the "webhook_secret" column; re-encrypt it for "_prev".
  let prevEnc: string | null = null;
  let droppedUnreadable = false;
  if (current.webhook_secret_enc) {
    // A current secret nobody can read any more (its key was dropped, or it was tampered with) has
    // nothing to keep for the overlap: it simply goes, so "register again" is the way out of that
    // state (review S3). Only that case: a configuration or other error propagates, so a GOOD
    // secret is never discarded because of a transient or unrelated failure.
    let plain: string | null = null;
    try {
      plain = await decryptToken(
        keyring(env),
        current.webhook_secret_enc,
        aad(connectionId, "webhook_secret"),
      );
    } catch (e) {
      if (!isUnreadableValue(e)) throw e;
      droppedUnreadable = true;
    }
    if (plain !== null) {
      prevEnc = await encryptToken(
        env.TOKEN_ENC_KEY,
        plain,
        aad(connectionId, "webhook_secret_prev"),
      );
    }
  }
  await env.DB.batch([
    auditStatement(env.DB, {
      actorEmail,
      action: "connection.revolut_webhook_secret_saved",
      entity: "connection",
      entityId: connectionId,
      after: {
        webhookId,
        rotated: prevEnc !== null,
        ...(droppedUnreadable ? { droppedUnreadablePrevious: true } : {}),
      },
    }),
    env.DB.prepare(
      `UPDATE connections SET webhook_id = ?2, webhook_secret_enc = ?3, webhook_secret_prev_enc = ?4,
         last_webhook_verified_at = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1 AND kind = 'revolut'`,
    ).bind(connectionId, webhookId, enc, prevEnc),
  ]);
}

/** Current signing secret first, then the previous one during a rotation. Never logged. */
export async function loadWebhookSecrets(
  env: { DB: D1Database; TOKEN_ENC_KEY: string; TOKEN_ENC_KEY_PREVIOUS?: string },
  connectionId: number,
): Promise<string[]> {
  const row = await env.DB.prepare(
    `SELECT webhook_secret_enc, webhook_secret_prev_enc FROM connections
     WHERE id = ?1 AND kind = 'revolut'`,
  )
    .bind(connectionId)
    .first<{ webhook_secret_enc: string | null; webhook_secret_prev_enc: string | null }>();
  const out: string[] = [];
  if (row?.webhook_secret_enc) {
    out.push(
      await decryptToken(keyring(env), row.webhook_secret_enc, aad(connectionId, "webhook_secret")),
    );
  }
  if (row?.webhook_secret_prev_enc) {
    out.push(
      await decryptToken(
        keyring(env),
        row.webhook_secret_prev_enc,
        aad(connectionId, "webhook_secret_prev"),
      ),
    );
  }
  return out;
}

/**
 * The webhook signing secrets as a pair, so the caller knows WHICH one verified. `current` is the
 * newest; `previous` is kept only for the rotation overlap. Never logged.
 *
 * Throws when the CURRENT secret cannot be read (or D1 fails). An unreadable PREVIOUS secret (its
 * key was dropped before it was re-encrypted) does not block the current one: it comes back as
 * `previous: null, previousUnreadable: true`, and the first delivery verified with the current
 * secret retires it. `stale`: a stored secret is still under another (previous) TOKEN_ENC_KEY; the
 * caller re-encrypts it (reencryptWebhookSecrets).
 */
export async function loadWebhookSecretSet(
  env: { DB: D1Database; TOKEN_ENC_KEY: string; TOKEN_ENC_KEY_PREVIOUS?: string },
  connectionId: number,
): Promise<{
  current: string | null;
  previous: string | null;
  stale: boolean;
  previousUnreadable: boolean;
}> {
  const row = await env.DB.prepare(
    `SELECT webhook_secret_enc, webhook_secret_prev_enc FROM connections
     WHERE id = ?1 AND kind = 'revolut'`,
  )
    .bind(connectionId)
    .first<{ webhook_secret_enc: string | null; webhook_secret_prev_enc: string | null }>();
  const current = row?.webhook_secret_enc
    ? await decryptToken(keyring(env), row.webhook_secret_enc, aad(connectionId, "webhook_secret"))
    : null;
  let previous: string | null = null;
  let previousUnreadable = false;
  if (row?.webhook_secret_prev_enc) {
    try {
      previous = await decryptToken(
        keyring(env),
        row.webhook_secret_prev_enc,
        aad(connectionId, "webhook_secret_prev"),
      );
    } catch (e) {
      if (!isUnreadableValue(e)) throw e;
      previousUnreadable = true;
    }
  }
  const stale =
    (!!row?.webhook_secret_enc &&
      !(await isEncryptedWith(env.TOKEN_ENC_KEY, row.webhook_secret_enc))) ||
    (previous !== null &&
      !!row?.webhook_secret_prev_enc &&
      !(await isEncryptedWith(env.TOKEN_ENC_KEY, row.webhook_secret_prev_enc)));
  return { current, previous, stale, previousUnreadable };
}

/**
 * Drops the previous webhook secret once a delivery verified with the new one (the rotation
 * overlap is over). One batch with its audit row; a no-op when there is no previous secret.
 */
export async function retirePreviousWebhookSecret(
  db: D1Database,
  connectionId: number,
): Promise<boolean> {
  const results = await db.batch([
    auditStatement(
      db,
      {
        actorEmail: "system",
        action: "connection.revolut_webhook_prev_secret_retired",
        entity: "connection",
        entityId: connectionId,
      },
      {
        sql: "EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND kind = 'revolut' AND webhook_secret_prev_enc IS NOT NULL)",
        binds: [connectionId],
      },
    ),
    db
      .prepare(
        `UPDATE connections SET webhook_secret_prev_enc = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND kind = 'revolut' AND webhook_secret_prev_enc IS NOT NULL`,
      )
      .bind(connectionId),
  ]);
  return (results[1]?.meta.changes ?? 0) === 1;
}

/**
 * Re-encrypts the webhook signing secrets under the CURRENT TOKEN_ENC_KEY (review S3). After a key
 * rotation (current = B, previous = A) the secrets are still under A until something rewrites
 * them; dropping A first would leave every delivery unverifiable. Idempotent and best effort:
 * nothing to do when both are already under the current key.
 *
 * Safety: each column is ONE UPDATE that is a compare-and-swap on the exact old ciphertext, and
 * the new ciphertext is complete before it is written, so a stored secret is never half written
 * and never lost: a failed write leaves the old (still readable) value; a lost race (another
 * request re-encrypted it, or an admin registered again) changes nothing. The AAD stays the
 * column's own, so ciphertexts still cannot be moved between columns or connections. No audit row
 * (the plaintext does not change).
 *
 * `readable` is false only when a stored secret cannot be decrypted with either key (the admin
 * must register again); `failed` counts writes or reads that failed for any other reason (retried
 * on the next refresh or delivery). Never throws.
 */
export async function reencryptWebhookSecrets(
  env: { DB: D1Database; TOKEN_ENC_KEY: string; TOKEN_ENC_KEY_PREVIOUS?: string },
  connectionId: number,
): Promise<{ readable: boolean; reencrypted: number; failed: number }> {
  let readable = true;
  let reencrypted = 0;
  let failed = 0;
  let row: { webhook_secret_enc: string | null; webhook_secret_prev_enc: string | null } | null;
  try {
    row = await env.DB.prepare(
      `SELECT webhook_secret_enc, webhook_secret_prev_enc FROM connections
       WHERE id = ?1 AND kind = 'revolut'`,
    )
      .bind(connectionId)
      .first<{ webhook_secret_enc: string | null; webhook_secret_prev_enc: string | null }>();
  } catch {
    return { readable, reencrypted, failed: 1 }; // D1 hiccup: the next refresh or delivery retries
  }
  if (!row) return { readable, reencrypted, failed };
  const columns = [
    { enc: row.webhook_secret_enc, kind: "webhook_secret" as const },
    { enc: row.webhook_secret_prev_enc, kind: "webhook_secret_prev" as const },
  ];
  for (const col of columns) {
    if (!col.enc) continue;
    let fresh: string;
    try {
      if (await isEncryptedWith(env.TOKEN_ENC_KEY, col.enc)) continue;
      const plain = await decryptToken(keyring(env), col.enc, aad(connectionId, col.kind));
      fresh = await encryptToken(env.TOKEN_ENC_KEY, plain, aad(connectionId, col.kind));
    } catch (e) {
      if (isUnreadableValue(e)) readable = false;
      else failed++;
      continue;
    }
    try {
      // Column names come from the closed list above, never from input.
      const r = await env.DB.prepare(
        `UPDATE connections SET ${col.kind}_enc = ?3
         WHERE id = ?1 AND kind = 'revolut' AND ${col.kind}_enc = ?2`,
      )
        .bind(connectionId, col.enc, fresh)
        .run();
      reencrypted += r.meta.changes;
    } catch {
      failed++;
    }
  }
  return { readable, reencrypted, failed };
}

/**
 * Whether every stored webhook secret decrypts with the current or previous key: true / false,
 * or null when that could not be checked (a D1 or configuration error says nothing about the
 * stored value, so it must not tell an admin to register again). Never throws.
 */
export async function webhookSecretsReadable(
  env: { DB: D1Database; TOKEN_ENC_KEY: string; TOKEN_ENC_KEY_PREVIOUS?: string },
  connectionId: number,
): Promise<boolean | null> {
  try {
    return !(await loadWebhookSecretSet(env, connectionId)).previousUnreadable;
  } catch (e) {
    return isUnreadableValue(e) ? false : null;
  }
}
