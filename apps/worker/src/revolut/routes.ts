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
 * before they are stored and never appear in a response, a log line or an audit row. New tokens
 * are staged as 'pending' (the gate serves only GET /accounts with them) until that call proved
 * the credentials work; only then the connection becomes 'active'.
 */
import { auditStatement } from "../db/audit";
import { claimOnceAndPurge } from "../db/idempotency";
import { clearCookie, parseCookies, REVOLUT_FLOW_COOKIE, setCookie } from "../auth/cookies";
import { randomBase64Url, safeEqual, sha256Hex } from "../auth/crypto";
import { FLOW_TTL_SECONDS, openFlow, sealFlow } from "../auth/flow-cookie";
import { isStepUpFresh } from "../auth/session";
import { encryptToken } from "../crypto/token-crypto";
import { json, type Ctx, type Router } from "../router";
import { probeAccounts } from "./accounts-probe";
import { isRevolutEnvironment, loadRevolutConfig, type RevolutConfig } from "./config";
import { createRevolutGateTransport } from "./gate-transport";
import { authorizeUrl, exchangeCode, TokenEndpointError } from "./oauth";
import { aad, environmentOf, loadRevolutConnection, REVOLUT_CONNECTION_NAME } from "./store";

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

    // Switching between production and sandbox would orphan the webhook subscription and mix
    // data of two Revolut accounts: disconnect first.
    const existing = await loadRevolutConnection(ctx.env.DB);
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
    const headers = new Headers({
      location: authorizeUrl(environment, cfg.config, state),
      "cache-control": "no-store",
    });
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
    const state = ctx.url.searchParams.get("state");
    const code = ctx.url.searchParams.get("code");
    if (!flow || !flow.revolut || !state || !(await safeEqual(state, flow.state))) {
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
    if (ctx.url.searchParams.has("error") || !code) {
      console.warn("revolut connect denied", "revolut_error");
      return back("denied");
    }
    const { environment, createsBankEntries, paymentsMode } = flow.revolut;

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
    // creates_bank_entries is written explicitly, never left to the column default.
    await db
      .prepare(
        `INSERT INTO connections (kind, name, status, creates_bank_entries)
         VALUES ('revolut', ?1, 'pending', ?2)
         ON CONFLICT (kind, name) DO NOTHING`,
      )
      .bind(REVOLUT_CONNECTION_NAME, createsBankEntries ? 1 : 0)
      .run();
    const row = await loadRevolutConnection(db);
    if (!row) return back("error");

    const key = ctx.env.TOKEN_ENC_KEY;
    const accessEnc = await encryptToken(key, tokens.accessToken, aad(row.id, "access"));
    const refreshEnc = await encryptToken(key, tokens.refreshToken, aad(row.id, "refresh"));
    const expiresAt = new Date(ctx.nowMs + tokens.expiresInS * 1000).toISOString();
    const nowIso = new Date(ctx.nowMs).toISOString();
    await db.batch([
      auditStatement(db, {
        actorEmail: session.email,
        action: "connection.revolut_authorized",
        entity: "connection",
        entityId: row.id,
        before: {
          status: row.status,
          environment: row.revolut_environment,
          createsBankEntries:
            row.bank_entries_decided_at === null ? null : row.creates_bank_entries === 1,
          paymentsMode: row.payments_mode,
        },
        after: { status: "pending", environment, createsBankEntries, paymentsMode },
      }),
      db
        .prepare(
          `UPDATE connections
           SET status = 'pending', access_token_enc = ?2, refresh_token_enc = ?3, expires_at = ?4,
               revolut_environment = ?5, creates_bank_entries = ?6, payments_mode = ?7,
               bank_entries_decided_at = ?8, last_error = NULL, token_ref = NULL, updated_at = ?8
           WHERE id = ?1 AND kind = 'revolut'`,
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
        ),
    ]);

    // Every later statement only acts while the staged tokens are still OURS (a second callback
    // running at the same time must not have its tokens activated by this one). The refresh
    // ciphertext is unique (random IV), so it identifies this callback's tokens.
    const mine = (enc: string, id = "?1"): string =>
      `EXISTS (SELECT 1 FROM connections WHERE id = ${id} AND kind = 'revolut' AND status = 'pending'
               AND refresh_token_enc = ${enc})`;
    const guard = { sql: mine("?7", "?8"), binds: [refreshEnc, row.id] };

    // Prove the credentials work, through the gate (the same path every later call takes).
    let accounts: number | null = null;
    try {
      accounts = await probeAccounts(createRevolutGateTransport(ctx.env, row.id), row.id);
    } catch (e) {
      console.warn("revolut accounts check failed", e instanceof Error ? e.name : "error");
    }
    if (accounts === null) {
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
          guard,
        ),
        db
          .prepare(
            `UPDATE connections
             SET status = 'disabled', last_error = 'verification_failed',
                 access_token_enc = NULL, refresh_token_enc = NULL, token_ref = NULL,
                 expires_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?1 AND ${mine("?2")}`,
          )
          .bind(row.id, refreshEnc),
      ]);
      return back("unverified");
    }

    const results = await db.batch([
      auditStatement(
        db,
        {
          actorEmail: session.email,
          action: "connection.revolut_connected",
          entity: "connection",
          entityId: row.id,
          before: { status: "pending" },
          after: { status: "active", environment, accounts },
        },
        guard,
      ),
      db
        .prepare(
          `UPDATE connections SET status = 'active', connected_by = ?2, connected_at = ?3,
             updated_at = ?3
           WHERE id = ?1 AND ${mine("?4")}`,
        )
        .bind(row.id, session.email, nowIso, refreshEnc),
    ]);
    return (results[1]?.meta.changes ?? 0) === 1 ? back("connected") : back("error");
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
    const live = `status IN ('active','needs_reauth','expired') OR (status = 'pending' AND refresh_token_enc IS NOT NULL)`;
    const results = await db.batch([
      auditStatement(
        db,
        {
          actorEmail: session.email,
          action: "connection.revolut_disconnected",
          entity: "connection",
          entityId: before.id,
          before: { status: before.status, environment: before.revolut_environment },
          after: { status: "disabled", webhookRemoved },
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
               webhook_secret_prev_enc = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
