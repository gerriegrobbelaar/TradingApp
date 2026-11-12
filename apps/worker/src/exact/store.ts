/**
 * D1 access for the Exact connection row. Tokens are encrypted before they reach this layer
 * (see crypto/token-crypto.ts) and the row type here never carries plaintext.
 * v1 has exactly one Exact connection (kind 'exact'); see ADR 0015.
 */
import { auditStatement } from "../db/audit";

export type ConnectionStatus = "pending" | "active" | "expired" | "disabled" | "needs_reauth";

export interface ExactConnectionRow {
  id: number;
  status: ConnectionStatus;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string | null;
  region_host: string;
}

export const EXACT_CONNECTION_NAME = "exact";

export const loadExactConnection = (db: D1Database): Promise<ExactConnectionRow | null> =>
  db
    .prepare(
      `SELECT id, status, access_token_enc, refresh_token_enc, expires_at, region_host
       FROM connections WHERE kind = 'exact' ORDER BY id LIMIT 1`,
    )
    .first<ExactConnectionRow>();

export const loadConnectionById = (
  db: D1Database,
  id: number,
): Promise<ExactConnectionRow | null> =>
  db
    .prepare(
      `SELECT id, status, access_token_enc, refresh_token_enc, expires_at, region_host
       FROM connections WHERE kind = 'exact' AND id = ?1`,
    )
    .bind(id)
    .first<ExactConnectionRow>();

/** AAD that binds each ciphertext to its connection and column. */
export const aad = (connectionId: number, kind: "access" | "refresh"): string =>
  `exact:${connectionId}:${kind}`;

/**
 * Marks an active connection as needing a person to re-authorise and wipes its tokens, in one
 * batch with the audit row (ADR 0013). The audit row comes first with the same guard, because
 * the UPDATE would otherwise make the guard false. Returns true if it changed anything.
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
        action: "connection.exact_needs_reauth",
        entity: "connection",
        entityId: connectionId,
        before: { status: "active" },
        after: { status: "needs_reauth", reason },
      },
      {
        sql: "EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND kind = 'exact' AND status = 'active')",
        binds: [connectionId],
      },
    ),
    db
      .prepare(
        `UPDATE connections
         SET status = 'needs_reauth', last_error = ?2, access_token_enc = NULL,
             refresh_token_enc = NULL, token_ref = NULL, expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND kind = 'exact' AND status = 'active'`,
      )
      .bind(connectionId, reason),
  ]);
  return (results[1]?.meta.changes ?? 0) === 1;
}
