/**
 * The webhook subscription lifecycle (Phase 5, task R3a, ADR 0033).
 *
 *  - Created once a connection is CONFIRMED (and by the admin action "Register webhook"):
 *    `POST /webhooks` for `<app origin>/api/webhooks/revolut` with the two transaction events. The
 *    signing secret in the answer is shown once; it is encrypted at once (saveWebhookSecret) and
 *    never logged, audited or returned.
 *  - A failure never blocks the connection. It is surfaced: `connections.last_error =
 *    'webhook_not_registered'` (a later token refresh clears last_error, so the connections list
 *    also reports `webhookRegistered` from the columns) and an audit row with a code.
 *  - Recovery from a lost creation response: Revolut then has a subscription for our URL whose
 *    secret we never received. Before creating, an account without a stored secret lists the
 *    subscriptions (the gate allows `GET /webhooks` only for job id `revolut-webhook-recover`),
 *    keeps ids and URLs only, deletes any subscription that points at our URL and creates a fresh
 *    one. The list response is never stored or logged.
 *  - Replace (rotation): create the new subscription first, store its secret (the old one moves to
 *    `webhook_secret_prev_enc` and stays valid until a delivery verifies with the new one), then
 *    delete the old subscription.
 */
import { createRevolutClient, type RevolutClient } from "@camelthorn/revolut";
import { auditStatement } from "../db/audit";
import type { Env } from "../env";
import { revolutWebhookUrl } from "./config";
import { classifyRevolutError } from "./errors";
import { createRevolutGateTransport } from "./gate-transport";
import { WEBHOOK_RECOVER_JOB_ID } from "./request";
import { saveWebhookSecret, type RevolutConnectionRow } from "./store";

export const WEBHOOK_NOT_REGISTERED = "webhook_not_registered";
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

class SecretNotSaved extends Error {}

export type WebhookRegistration =
  { status: "registered" | "already_registered" } | { status: "failed"; code: string };

const clientFor = (env: Env, connectionId: number, jobId: string): RevolutClient =>
  createRevolutClient(createRevolutGateTransport(env, connectionId), {
    connectionId,
    jobId,
    priority: "user",
  });

export async function registerWebhook(
  env: Env,
  conn: Pick<RevolutConnectionRow, "id" | "status" | "webhook_id">,
  actorEmail: string,
  opts: { appOrigin: string; replace?: boolean },
): Promise<WebhookRegistration> {
  const db = env.DB;
  if (conn.status !== "active") return { status: "failed", code: "not_active" };
  const url = revolutWebhookUrl(opts.appOrigin);
  const stored = await db
    .prepare(
      "SELECT webhook_id, webhook_secret_enc IS NOT NULL AS has_secret FROM connections WHERE id = ?1",
    )
    .bind(conn.id)
    .first<{ webhook_id: string | null; has_secret: number }>();
  const hasSecret = stored?.has_secret === 1 && stored.webhook_id !== null;

  const clearFlag = () =>
    db
      .prepare(
        `UPDATE connections SET last_error = NULL
         WHERE id = ?1 AND kind = 'revolut' AND last_error = '${WEBHOOK_NOT_REGISTERED}'`,
      )
      .bind(conn.id)
      .run();
  if (hasSecret && opts.replace !== true) {
    await clearFlag();
    return { status: "already_registered" };
  }

  try {
    // Recovery: a subscription for our URL whose secret we do not hold (a lost creation response)
    // is deleted so there is exactly one. Failure to list is not fatal: creating is what matters.
    if (!hasSecret) {
      try {
        const list = await clientFor(env, conn.id, WEBHOOK_RECOVER_JOB_ID).listWebhooks();
        for (const wh of list) {
          if (wh.url !== url || !UUID_RE.test(wh.id)) continue;
          await clientFor(env, conn.id, "revolut-webhook").deleteWebhook(wh.id);
          await auditStatement(db, {
            actorEmail,
            action: "connection.revolut_webhook_deleted",
            entity: "connection",
            entityId: conn.id,
            after: { webhookId: wh.id, reason: "recovery" },
          }).run();
        }
      } catch (e) {
        console.warn("revolut webhook recovery skipped", classifyRevolutError(e).code);
      }
    }

    const created = await clientFor(env, conn.id, "revolut-webhook").createWebhook(url);
    try {
      await saveWebhookSecret(env, conn.id, created.id, created.signingSecret, actorEmail);
    } catch {
      // The subscription exists but its secret is lost; the next attempt deletes it first.
      throw new SecretNotSaved();
    }
    if (opts.replace === true && stored?.webhook_id && UUID_RE.test(stored.webhook_id)) {
      // Old subscription: best effort. If it stays, both deliver, and both secrets verify.
      try {
        await clientFor(env, conn.id, "revolut-webhook").deleteWebhook(stored.webhook_id);
        await auditStatement(db, {
          actorEmail,
          action: "connection.revolut_webhook_deleted",
          entity: "connection",
          entityId: conn.id,
          after: { webhookId: stored.webhook_id, reason: "replaced" },
        }).run();
      } catch {
        console.warn("revolut old webhook not deleted");
      }
    }
    await clearFlag();
    return { status: "registered" };
  } catch (e) {
    const code = e instanceof SecretNotSaved ? "secret_not_saved" : classifyRevolutError(e).code;
    await db.batch([
      auditStatement(db, {
        actorEmail,
        action: "connection.revolut_webhook_failed",
        entity: "connection",
        entityId: conn.id,
        after: { failure: code, replace: opts.replace === true },
      }),
      db
        .prepare(
          `UPDATE connections SET last_error = '${WEBHOOK_NOT_REGISTERED}',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?1 AND kind = 'revolut' AND status = 'active' AND last_error IS NULL`,
        )
        .bind(conn.id),
    ]);
    return { status: "failed", code };
  }
}
