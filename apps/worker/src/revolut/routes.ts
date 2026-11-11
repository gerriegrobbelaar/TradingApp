/**
 * Revolut Business connection routes (admin only). Mirrors the Exact connect flow
 * (exact/routes.ts, ADR 0016, ADR 0019): starting and disconnecting need a fresh Google sign-in
 * (CLAUDE.md 4.0 step-up); the callback is a browser navigation, so it instead requires the same
 * admin session that started the flow (the signed round-trip cookie is bound to that email) and
 * answers with redirects, never JSON error pages. The `state` is single use (claimed before the
 * code is spent).
 *
 * The admin must say explicitly who creates bank entries in Exact (CLAUDE.md 3, open decision 2):
 * `creates_bank_entries=1` means this app creates them, `0` means Revolut's own Exact integration
 * (or someone else) does and this app only matches. There is no default: a request without it is
 * refused, and the choice is stored with the time it was made.
 *
 * Every change is one db.batch of the change plus its audit row (ADR 0013). Tokens are encrypted
 * before they are stored and never appear in a response, a log line or an audit row.
 *
 * Account substitution (review R2, ADR 0031): Revolut may not echo `state` on the consent
 * redirect, so the callback cannot prove that the authorisation code came from the flow this
 * browser started. An attacker could make an admin's browser deliver the attacker's code and
 * connect the attacker's Revolut account. Defence in depth: the callback only STAGES the tokens
 * ('pending', 15 minutes, usable for nothing but reading the account list), and a second explicit
 * admin action with a fresh sign-in (POST /confirm) activates them after the admin has seen which
 * accounts were connected. When Revolut does echo `state`, it must match (a mismatch is refused).
 */
import { auditStatement } from "../db/audit";
import { claimOnceAndPurge } from "../db/idempotency";
import { clearCookie, parseCookies, REVOLUT_FLOW_COOKIE, setCookie } from "../auth/cookies";
import { randomBase64Url, safeEqual, sha256Hex } from "../auth/crypto";
import { FLOW_TTL_SECONDS, openFlow, sealFlow } from "../auth/flow-cookie";
import { isStepUpFresh } from "../auth/session";
import { encryptToken } from "../crypto/token-crypto";
import { json, type Ctx, type Router } from "../router";
import { inspectAccounts } from "./accounts-probe";
import { isRevolutEnvironment, loadRevolutConfig, type RevolutConfig } from "./config";
import { createRevolutGateTransport } from "./gate-transport";
import { queueInitialBackfill } from "./initial-backfill";
import { registerWebhook } from "./webhooks";
import { authorizeUrl, exchangeCode, TokenEndpointError } from "./oauth";
import {
  aad,
  environmentOf,
  expireRevolutPending,
  isLivePending,
  loadRevolutConnection,
  parsePendingSummary,
  PENDING_TTL_MS,
  REVOLUT_CONNECTION_NAME,
} from "./store";

const ADMIN_STEP_UP = { roles: ["admin"], stepUp: true } as const;
const ADMIN = { roles: ["admin"] } as const;

const RETURN_TO = "/settings/connections";
const FLOW_SCOPE = "revolut.flow";
const FLOW_KEY_RETENTION_MS = 24 * 3600 * 1000;
const PURGE_BATCH = 100;
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const back = (result: string, clearFlow = true): Response => {
  const headers = new Headers({
    location: `${RETURN_TO}?revolut=${result}`,
    "cache-control": "no-store",
  });
  if (clearFlow) headers.append("set-cookie", clearCookie(REVOLUT_FLOW_COOKIE));
  return new Response(null, { status: 302, headers });
};

/** Loads the Revolut settings or answers 500 server_misconfigured (names only in the log). */
function revolutConfig(ctx: Ctx): { config: RevolutConfig } | { response: Response } {
  const cfg = loadRevolutConfig(ctx.env, ctx.config.appOrigin);
  if (!cfg.ok) {
    console.error("revolut configuration incomplete", cfg.missing.join(","));
    return { response: json({ error: "server_misconfigured" }, 500) };
  }
  return { config: cfg.config };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await request.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isPaymentsMode = (v: unknown): v is "drafts" | "pay" => v === "drafts" || v === "pay";

export function registerRevolutRoutes(router: Router): void {
  router.add("GET", "/api/connections/revolut/start", ADMIN_STEP_UP, async (ctx) => {
    const q = ctx.url.searchParams;
    // No defaults: every choice is explicit (review S11).
    const environment = q.get("environment");
    if (!isRevolutEnvironment(environment)) return json({ error: "invalid_environment" }, 400);
    const bankEntries = q.get("creates_bank_entries");
    if (bankEntries !== "0" && bankEntries !== "1") {
      return json({ error: "creates_bank_entries_required" }, 400);
    }
    const mode = q.get("payments_mode") ?? "drafts";
    if (!isPaymentsMode(mode)) return json({ error: "invalid_payments_mode" }, 400);

    const cfg = revolutConfig(ctx);
    if ("response" in cfg) return cfg.response;
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);

    await expireRevolutPending(ctx.env.DB, ctx.nowMs);
    const existing = await loadRevolutConnection(ctx.env.DB);
    // A working connection is never replaced by a new consent: a substituted code could otherwise
    // take it over. Disconnect first (re-authorising is for needs_reauth / expired).
    if (existing?.status === "active") return json({ error: "already_connected" }, 409);
    // Switching between production and sandbox would orphan the webhook subscription and mix
    // data of two Revolut accounts: disconnect first.
    if (
      existing &&
      existing.status !== "disabled" &&
      environmentOf(existing) !== null &&
      environmentOf(existing) !== environment
    ) {
      return json({ error: "environment_change_requires_disconnect" }, 409);
    }

    const state = randomBase64Url(32);
    const sealed = await sealFlow(ctx.config.sessionSecret, {
      state,
      nonce: randomBase64Url(16), // unused by Revolut; keeps the shared cookie shape
      verifier: "",
      stepUp: true,
      returnTo: RETURN_TO,
      bind: session.email,
      exp: ctx.nowMs + FLOW_TTL_SECONDS * 1000,
      revolut: { environment, createsBankEntries: bankEntries === "1", paymentsMode: mode },
    });
    let location: string;
    try {
      location = authorizeUrl(environment, cfg.config, state);
    } catch {
      console.error("revolut configuration incomplete", "consent_url");
      return json({ error: "server_misconfigured" }, 500);
    }
    const headers = new Headers({ location, "cache-control": "no-store" });
    headers.append("set-cookie", setCookie(REVOLUT_FLOW_COOKIE, sealed, FLOW_TTL_SECONDS));
    return new Response(null, { status: 302, headers });
  });

  router.add("GET", "/api/connections/revolut/callback", ADMIN, async (ctx) => {
    const cfg = revolutConfig(ctx);
    if ("response" in cfg) return cfg.response;
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const db = ctx.env.DB;

    const flow = await openFlow(
      ctx.config.sessionSecret,
      parseCookies(ctx.request.headers.get("cookie")).get(REVOLUT_FLOW_COOKIE),
      ctx.nowMs,
    );
    if (!flow || !flow.revolut) {
      console.warn("revolut connect denied", "no_flow");
      return back("denied");
    }
    // When Revolut echoes `state` it must be ours. Without it (unverified whether Revolut sends
    // it) the flow is bound by the signed cookie only, and the staged connection must be
    // confirmed by an admin who has seen what was connected before anything uses it.
    const state = ctx.url.searchParams.get("state");
    const stateEchoed = state !== null;
    if (stateEchoed && !(await safeEqual(state, flow.state))) {
      console.warn("revolut connect denied", "bad_state");
      return back("denied");
    }
    // The flow belongs to the admin who started it (step-up happened then).
    if (flow.bind !== session.email) {
      console.warn("revolut connect denied", "wrong_user");
      return back("denied");
    }
    // Single use, claimed before the code is spent.
    const claimed = await claimOnceAndPurge(db, await sha256Hex(flow.state), FLOW_SCOPE, {
      nowMs: ctx.nowMs,
      retentionMs: FLOW_KEY_RETENTION_MS,
      purgeLimit: PURGE_BATCH,
    });
    if (!claimed) {
      console.warn("revolut connect denied", "flow_replayed");
      return back("denied");
    }
    const code = ctx.url.searchParams.get("code");
    if (ctx.url.searchParams.has("error") || !code || code.length > 2048) {
      console.warn("revolut connect denied", "revolut_error");
      return back("denied");
    }
    const { environment, createsBankEntries, paymentsMode } = flow.revolut;

    await expireRevolutPending(db, ctx.nowMs);
    const existing = await loadRevolutConnection(db);
    // Re-checked here: the connection may have changed since the flow started.
    if (existing?.status === "active") {
      console.warn("revolut connect denied", "already_connected");
      return back("denied");
    }
    if (
      existing &&
      existing.status !== "disabled" &&
      environmentOf(existing) !== null &&
      environmentOf(existing) !== environment
    ) {
      console.warn("revolut connect denied", "environment_changed");
      return back("denied");
    }

    let tokens;
    try {
      tokens = await exchangeCode(environment, cfg.config, code, ctx.nowMs);
    } catch (e) {
      console.warn(
        "revolut code exchange failed",
        e instanceof TokenEndpointError ? e.failure : "error",
      );
      return back("error");
    }
    if (tokens.refreshToken === null) return back("error"); // exchangeCode already guarantees one

    // The ciphertext is bound to the connection id, so make sure the (single) row exists first.
    // It starts 'disabled' (no tokens); creates_bank_entries is written explicitly below.
    await db
      .prepare(
        `INSERT INTO connections (kind, name, status, creates_bank_entries)
         VALUES ('revolut', ?1, 'disabled', ?2)
         ON CONFLICT (kind, name) DO NOTHING`,
      )
      .bind(REVOLUT_CONNECTION_NAME, createsBankEntries ? 1 : 0)
      .run();
    const row = await loadRevolutConnection(db);
    if (!row || row.status === "active") return back("error");

    const key = ctx.env.TOKEN_ENC_KEY;
    const accessEnc = await encryptToken(key, tokens.accessToken, aad(row.id, "access"));
    const refreshEnc = await encryptToken(key, tokens.refreshToken, aad(row.id, "refresh"));
    const expiresAt = new Date(ctx.nowMs + tokens.expiresInS * 1000).toISOString();
    const nowIso = new Date(ctx.nowMs).toISOString();
    const pendingUntil = new Date(ctx.nowMs + PENDING_TTL_MS).toISOString();
    const ref = randomBase64Url(18);
    // Staged only while the row is not active (a concurrent confirm must never be overwritten).
    const staged = await db.batch([
      auditStatement(
        db,
        {
          actorEmail: session.email,
          action: "connection.revolut_staged",
          entity: "connection",
          entityId: row.id,
          before: {
            status: row.status,
            environment: row.revolut_environment,
            createsBankEntries:
              row.bank_entries_decided_at === null ? null : row.creates_bank_entries === 1,
            paymentsMode: row.payments_mode,
          },
          after: {
            status: "pending",
            environment,
            createsBankEntries,
            paymentsMode,
            stateEchoed,
            pendingUntil,
          },
        },
        {
          sql: "EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND kind = 'revolut' AND status <> 'active')",
          binds: [row.id],
        },
      ),
      db
        .prepare(
          `UPDATE connections
           SET status = 'pending', access_token_enc = ?2, refresh_token_enc = ?3, expires_at = ?4,
               revolut_environment = ?5, creates_bank_entries = ?6, payments_mode = ?7,
               bank_entries_decided_at = ?8, last_error = NULL, token_ref = NULL, updated_at = ?8,
               pending_until = ?9, pending_ref = ?10, pending_by = ?11, pending_summary = NULL,
               refresh_expires_at = ?12
           WHERE id = ?1 AND kind = 'revolut' AND status <> 'active'`,
        )
        .bind(
          row.id,
          accessEnc,
          refreshEnc,
          expiresAt,
          environment,
          createsBankEntries ? 1 : 0,
          paymentsMode,
          nowIso,
          pendingUntil,
          ref,
          session.email,
          tokens.refreshExpiresInS === null
            ? null
            : new Date(ctx.nowMs + tokens.refreshExpiresInS * 1000).toISOString(),
        ),
    ]);
    if ((staged[1]?.meta.changes ?? 0) !== 1) return back("error");

    // Every later statement only acts while the staged tokens are still OURS (a second callback
    // running at the same time must not have its tokens summarised or wiped by this one).
    const mine = (refParam: string, id = "?1"): string =>
      `EXISTS (SELECT 1 FROM connections WHERE id = ${id} AND kind = 'revolut' AND status = 'pending'
               AND pending_ref = ${refParam})`;

    // Prove the credentials work and collect what the admin must check, through the gate (the
    // same path every later call takes; it serves a staged connection nothing but the account list).
    const previous = await db
      .prepare("SELECT external_id FROM bank_accounts WHERE connection_id = ?1")
      .bind(row.id)
      .all<{ external_id: string }>();
    let summary = null;
    try {
      summary = await inspectAccounts(
        createRevolutGateTransport(ctx.env, row.id),
        row.id,
        previous.results.map((r) => r.external_id),
        stateEchoed,
      );
    } catch (e) {
      console.warn("revolut accounts check failed", e instanceof Error ? e.name : "error");
    }
    if (summary === null) {
      await db.batch([
        auditStatement(
          db,
          {
            actorEmail: session.email,
            action: "connection.revolut_verification_failed",
            entity: "connection",
            entityId: row.id,
            after: { status: "disabled", refused: true },
          },
          { sql: mine("?8", "?7"), binds: [row.id, ref] },
        ),
        db
          .prepare(
            `UPDATE connections
             SET status = 'disabled', last_error = 'verification_failed',
                 access_token_enc = NULL, refresh_token_enc = NULL, token_ref = NULL,
                 expires_at = NULL, pending_until = NULL, pending_ref = NULL, pending_by = NULL,
                 pending_summary = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?1 AND ${mine("?2")}`,
          )
          .bind(row.id, ref),
      ]);
      return back("unverified");
    }

    const saved = await db
      .prepare(
        `UPDATE connections SET pending_summary = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND ${mine("?3")}`,
      )
      .bind(row.id, JSON.stringify(summary), ref)
      .run();
    return saved.meta.changes === 1 ? back("confirm") : back("error");
  });

  /**
   * Activates a staged connection. The admin has seen the summary (accounts, currencies, last 4
   * of the IBANs) and ticked that it is the company's own Revolut Business account. `ref` must be
   * the one of the summary shown, so a different staging that happened meanwhile is not
   * confirmed blindly. If the connection replaces one whose accounts all differ, that needs its
   * own explicit flag.
   */
  router.add("POST", "/api/connections/revolut/confirm", ADMIN_STEP_UP, async (ctx) => {
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const body = await readJson(ctx.request);
    const keys = body ? Object.keys(body) : [];
    if (
      !body ||
      keys.some((k) => k !== "ref" && k !== "ownAccount" && k !== "replacesAccounts") ||
      typeof body.ref !== "string" ||
      body.ref === "" ||
      body.ref.length > 64 ||
      (body.replacesAccounts !== undefined && typeof body.replacesAccounts !== "boolean")
    ) {
      return json({ error: "invalid_body" }, 400);
    }
    if (body.ownAccount !== true) return json({ error: "own_account_confirmation_required" }, 400);
    const db = ctx.env.DB;
    if (await expireRevolutPending(db, ctx.nowMs)) return json({ error: "pending_expired" }, 410);
    const row = await loadRevolutConnection(db);
    if (!row || row.status !== "pending" || row.pending_ref === null) {
      return json({ error: "nothing_to_confirm" }, 409);
    }
    if (!(await safeEqual(body.ref, row.pending_ref))) {
      return json({ error: "nothing_to_confirm" }, 409);
    }
    if (!isLivePending(row, ctx.nowMs)) return json({ error: "pending_expired" }, 410);
    const summary = parsePendingSummary(row.pending_summary);
    if (!summary) return json({ error: "not_verified" }, 409);
    const replaces = summary.previousAccounts > 0 && summary.matchingAccounts === 0;
    if (replaces && body.replacesAccounts !== true) {
      return json({ error: "different_account_confirmation_required" }, 409);
    }
    const nowIso = new Date(ctx.nowMs).toISOString();
    const live = `kind = 'revolut' AND status = 'pending' AND pending_ref = ?REF AND pending_until > ?NOW
                  AND pending_summary IS NOT NULL`;
    const results = await db.batch([
      auditStatement(
        db,
        {
          actorEmail: session.email,
          action: "connection.revolut_confirmed",
          entity: "connection",
          entityId: row.id,
          before: { status: "pending", stagedBy: row.pending_by },
          after: {
            status: "active",
            environment: row.revolut_environment,
            accountCount: summary.accountCount,
            currencies: summary.currencies,
            holders: summary.holders,
            replacesAccounts: replaces,
            stateEchoed: summary.stateEchoed,
          },
        },
        {
          sql: `EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND ${live.replace("?REF", "?8").replace("?NOW", "?9")})`,
          binds: [row.id, row.pending_ref, nowIso],
        },
      ),
      db
        .prepare(
          `UPDATE connections SET status = 'active', connected_by = ?4, connected_at = ?3,
             pending_until = NULL, pending_ref = NULL, pending_by = NULL, pending_summary = NULL,
             updated_at = ?3
           WHERE id = ?1 AND ${live.replace("?REF", "?2").replace("?NOW", "?3")}`,
        )
        .bind(row.id, row.pending_ref, nowIso, session.email),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1) return json({ error: "nothing_to_confirm" }, 409);

    // After activation, and neither blocks the confirmation: the webhook subscription (a failure
    // is surfaced as last_error 'webhook_not_registered' and fixed by "Register webhook") and the
    // one-off 90-day backfill (picked up by the next run if it cannot be enqueued now).
    const active = await loadRevolutConnection(db);
    let webhook = "failed";
    if (active) {
      try {
        webhook = (
          await registerWebhook(ctx.env, active, session.email, {
            appOrigin: ctx.config.appOrigin,
          })
        ).status;
      } catch (e) {
        console.error("revolut webhook registration crashed", e instanceof Error ? e.name : "");
      }
    }
    let backfill = "failed";
    try {
      backfill = await queueInitialBackfill(ctx.env, row.id, session.email, ctx.nowMs);
    } catch (e) {
      console.error("revolut initial backfill not queued", e instanceof Error ? e.name : "");
    }
    return json({ ok: true, webhook, backfill });
  });

  /**
   * Registers (or recovers, or with `replace: true` rotates) the webhook subscription. Admin with a
   * fresh sign-in: the subscription decides where every transaction notification goes.
   */
  router.add("POST", "/api/connections/revolut/webhook/register", ADMIN_STEP_UP, async (ctx) => {
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const body = await readJson(ctx.request);
    const keys = body ? Object.keys(body) : [];
    if (
      !body ||
      keys.some((k) => k !== "replace") ||
      (body.replace !== undefined && typeof body.replace !== "boolean")
    ) {
      return json({ error: "invalid_body" }, 400);
    }
    const row = await loadRevolutConnection(ctx.env.DB);
    if (!row || row.status !== "active") return json({ error: "not_active" }, 409);
    const r = await registerWebhook(ctx.env, row, session.email, {
      appOrigin: ctx.config.appOrigin,
      replace: body.replace === true,
    });
    if (r.status === "failed") {
      return json({ ok: false, error: "webhook_registration_failed", code: r.code }, 502);
    }
    return json({ ok: true, status: r.status });
  });

  router.add("POST", "/api/connections/revolut/disconnect", ADMIN_STEP_UP, async (ctx) => {
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const db = ctx.env.DB;
    const before = await loadRevolutConnection(db);
    if (!before) return json({ ok: true, changed: false });

    // Best effort: remove the webhook subscription while the tokens still work. A failure never
    // blocks the disconnect (the subscription then delivers to an endpoint that finds no
    // connection and ignores it); the outcome is audited.
    let webhookRemoved: boolean | null = null;
    if (
      before.status === "active" &&
      before.webhook_id !== null &&
      UUID_RE.test(before.webhook_id)
    ) {
      try {
        const res = await createRevolutGateTransport(
          ctx.env,
          before.id,
        )({
          method: "DELETE",
          path: `/webhooks/${before.webhook_id}`,
          apiVersion: "2.0",
          connectionId: before.id,
          priority: "user",
          jobId: "revolut-disconnect",
        });
        webhookRemoved = res.status >= 200 && res.status < 300;
      } catch {
        webhookRemoved = false;
      }
    }
    // A staged connection counts too: "Cancel, this is not our account" is a disconnect.
    const live = `status IN ('active','needs_reauth','expired','pending')
      OR access_token_enc IS NOT NULL OR refresh_token_enc IS NOT NULL`;
    const results = await db.batch([
      auditStatement(
        db,
        {
          actorEmail: session.email,
          action: "connection.revolut_disconnected",
          entity: "connection",
          entityId: before.id,
          before: { status: before.status, environment: before.revolut_environment },
          after: { status: "disabled", webhookRemoved, wasStaged: before.status === "pending" },
        },
        {
          sql: `EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND kind = 'revolut' AND (${live}))`,
          binds: [before.id],
        },
      ),
      db
        .prepare(
          `UPDATE connections
           SET status = 'disabled', access_token_enc = NULL, refresh_token_enc = NULL, token_ref = NULL,
               expires_at = NULL, last_error = NULL, webhook_id = NULL, webhook_secret_enc = NULL,
               webhook_secret_prev_enc = NULL, pending_until = NULL, pending_ref = NULL,
               pending_by = NULL, pending_summary = NULL, refresh_expires_at = NULL,
               last_webhook_verified_at = NULL, last_webhook_rejected_at = NULL,
               webhook_rejected_total = 0,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?1 AND kind = 'revolut' AND (${live})`,
        )
        .bind(before.id),
    ]);
    // Idempotent: disconnecting what is already disconnected changes nothing and audits nothing.
    return json({ ok: true, changed: (results[1]?.meta.changes ?? 0) === 1 });
  });

  router.add("PATCH", "/api/connections/revolut/settings", ADMIN, async (ctx) => {
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const body = await readJson(ctx.request);
    if (!body) return json({ error: "invalid_body" }, 400);
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((k) => k !== "createsBankEntries" && k !== "paymentsMode")) {
      return json({ error: "invalid_body" }, 400);
    }
    const wantBank = body.createsBankEntries;
    const wantMode = body.paymentsMode;
    if (wantBank !== undefined && typeof wantBank !== "boolean")
      return json({ error: "invalid_body" }, 400);
    if (wantMode !== undefined && !isPaymentsMode(wantMode))
      return json({ error: "invalid_payments_mode" }, 400);

    const db = ctx.env.DB;
    const row = await loadRevolutConnection(db);
    if (!row || row.status === "disabled" || row.status === "pending") {
      return json({ error: "not_connected" }, 404);
    }
    const nextBank = wantBank === undefined ? row.creates_bank_entries === 1 : wantBank;
    const nextMode = wantMode === undefined ? row.payments_mode : wantMode;
    const bankChanged =
      row.bank_entries_decided_at === null || nextBank !== (row.creates_bank_entries === 1);
    const modeChanged = nextMode !== row.payments_mode;
    if (!bankChanged && !modeChanged) return json({ ok: true, changed: false });
    // Changing either setting changes where money-relevant bookings happen: fresh sign-in needed.
    if (!isStepUpFresh(session, ctx.nowMs)) return json({ error: "step_up_required" }, 401);

    const guard = {
      sql: "EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND kind = 'revolut' AND status IN ('active','needs_reauth','expired'))",
      binds: [row.id],
    };
    const nowIso = new Date(ctx.nowMs).toISOString();
    const results = await db.batch([
      auditStatement(
        db,
        {
          actorEmail: session.email,
          action: "connection.revolut_settings_changed",
          entity: "connection",
          entityId: row.id,
          before: {
            createsBankEntries:
              row.bank_entries_decided_at === null ? null : row.creates_bank_entries === 1,
            paymentsMode: row.payments_mode,
          },
          after: { createsBankEntries: nextBank, paymentsMode: nextMode },
        },
        guard,
      ),
      db
        .prepare(
          `UPDATE connections
           SET creates_bank_entries = ?2, payments_mode = ?3, bank_entries_decided_at = ?4, updated_at = ?4
           WHERE id = ?1 AND kind = 'revolut' AND status IN ('active','needs_reauth','expired')`,
        )
        .bind(
          row.id,
          nextBank ? 1 : 0,
          nextMode,
          bankChanged ? nowIso : row.bank_entries_decided_at,
        ),
    ]);
    return json({
      ok: true,
      changed: (results[1]?.meta.changes ?? 0) === 1,
      createsBankEntries: nextBank,
      paymentsMode: nextMode,
    });
  });
}
