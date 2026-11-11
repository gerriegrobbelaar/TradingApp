/**
 * D1 access for the Revolut connection row. Tokens and webhook signing secrets are encrypted
 * before they reach this layer (crypto/token-crypto.ts); the row types here never carry plaintext.
 * v1 has exactly one Revolut connection (kind 'revolut', name 'revolut'); see ADR 0031.
 */
import { auditStatement } from "../db/audit";
import { decryptToken, encryptToken, keyring } from "../crypto/token-crypto";
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
}

const COLUMNS = `id, status, access_token_enc, refresh_token_enc, expires_at, last_error,
  revolut_environment, creates_bank_entries, payments_mode, bank_entries_decided_at, webhook_id,
  connected_by, connected_at`;

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
  env: { DB: D1Database; TOKEN_ENC_KEY: string },
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
  if (current.webhook_secret_enc) {
    const plain = await decryptToken(
      keyring(env),
      current.webhook_secret_enc,
      aad(connectionId, "webhook_secret"),
    );
    prevEnc = await encryptToken(
      env.TOKEN_ENC_KEY,
      plain,
      aad(connectionId, "webhook_secret_prev"),
    );
  }
  await env.DB.batch([
    auditStatement(env.DB, {
      actorEmail,
      action: "connection.revolut_webhook_secret_saved",
      entity: "connection",
      entityId: connectionId,
      after: { webhookId, rotated: prevEnc !== null },
    }),
    env.DB.prepare(
      `UPDATE connections SET webhook_id = ?2, webhook_secret_enc = ?3, webhook_secret_prev_enc = ?4,
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
