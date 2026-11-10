/**
 * Exact connection routes (admin only where it changes anything). Connecting needs a fresh Google
 * sign-in (CLAUDE.md 4.0 step-up) when the flow starts; the callback is a browser navigation, so
 * it instead requires the same admin session that started the flow (the signed round-trip cookie
 * is bound to that email) and answers with redirects, never JSON error pages.
 *
 * Every change is one db.batch of the change plus its audit row (ADR 0013). Tokens are encrypted
 * before they are stored and never appear in a response, a log line or an audit row.
 *
 * Reconnecting to a DIFFERENT Exact account (review S7, ADR 0016 item 21): the callback compares
 * the identity of the account /current/Me reports with the one stored on the connection. If it
 * differs, nothing is replaced unless the flow was started with `confirm_replace=1`: the saved
 * sign-in is removed again (the connection is disabled, its old identity and divisions are kept)
 * and the callback answers `?exact=different_exact_account`. With the confirmation the old
 * divisions are switched off for syncing and the new account's current division is enabled.
 */
import { auditStatement } from "../db/audit";
import { claimOnceAndPurge } from "../db/idempotency";
import { clearCookie, EXACT_FLOW_COOKIE, parseCookies, setCookie } from "../auth/cookies";
import { randomBase64Url, safeEqual, sha256Hex } from "../auth/crypto";
import { FLOW_TTL_SECONDS, openFlow, sealFlow } from "../auth/flow-cookie";
import { json, type Ctx, type Router } from "../router";
import { fetchCurrentMe, type CurrentMe } from "@camelthorn/exact";
import { encryptToken } from "../crypto/token-crypto";
import { DEFAULT_EXACT_HOST, loadExactConfig, type ExactConfig } from "./config";
import { createCurrentGateTransport } from "./gate-transport";
import { authorizeUrl, exchangeCode, TokenEndpointError } from "./oauth";
import { aad, EXACT_CONNECTION_NAME } from "./store";

const ADMIN_STEP_UP = { roles: ["admin"], stepUp: true } as const;
const ADMIN = { roles: ["admin"] } as const;
const ANY_ROLE = { roles: ["admin", "finance", "approver", "viewer"] } as const;

const RETURN_TO = "/settings/connections";
const FLOW_SCOPE = "exact.flow";
const FLOW_KEY_RETENTION_MS = 24 * 3600 * 1000;
const PURGE_BATCH = 100;

const back = (result: string, clearFlow = true): Response => {
  const headers = new Headers({
    location: `${RETURN_TO}?exact=${result}`,
    "cache-control": "no-store",
  });
  if (clearFlow) headers.append("set-cookie", clearCookie(EXACT_FLOW_COOKIE));
  return new Response(null, { status: 302, headers });
};

/** Loads the Exact settings or answers 500 server_misconfigured (names only in the log). */
function exactConfig(ctx: Ctx): { config: ExactConfig } | { response: Response } {
  const cfg = loadExactConfig(ctx.env, ctx.config.appOrigin);
  if (!cfg.ok) {
    console.error("exact configuration incomplete", cfg.missing.join(","));
    return { response: json({ error: "server_misconfigured" }, 500) };
  }
  return { config: cfg.config };
}

/**
 * Stable identity of the Exact account (subscription owner) behind a /current/Me answer: a hash of
 * the customer id, else of the customer name. Null when Exact sent neither. Only the hash is
 * stored; audit rows carry its first 12 characters.
 */
export async function exactIdentity(me: CurrentMe): Promise<string | null> {
  const key =
    me.divisionCustomerId ?? (me.divisionCustomerName ?? "").trim().toLowerCase().slice(0, 200);
  return key === "" ? null : sha256Hex(`exact-account:${key}`);
}

/**
 * True when the account behind `me` is not the one this connection was used with. Identities are
 * compared when both sides have one; otherwise (a connection made before identities were stored,
 * or Exact without the customer fields) the division list decides: a current division we have
 * never seen means a different account. A connection with no history is never "different".
 */
export function isDifferentAccount(
  prior: { identity: string | null; divisions: readonly number[] },
  next: { identity: string | null; division: number },
): boolean {
  if (prior.identity === null && prior.divisions.length === 0) return false;
  if (prior.identity !== null && next.identity !== null) return prior.identity !== next.identity;
  return prior.divisions.length > 0 && !prior.divisions.includes(next.division);
}

const divisionName = (me: CurrentMe): string =>
  me.divisionCustomerName !== null && me.divisionCustomerName !== ""
    ? me.divisionCustomerName.slice(0, 200)
    : `Division ${me.currentDivision}`;

export function registerExactRoutes(router: Router): void {
  // Status only: tokens are never selected.
  router.add("GET", "/api/connections", ANY_ROLE, async (ctx) => {
    const db = ctx.env.DB;
    const { results } = await db
      .prepare(
        `SELECT id, kind, name, status, expires_at, last_error, connected_by, connected_at
         FROM connections ORDER BY id`,
      )
      .all<{
        id: number;
        kind: string;
        name: string;
        status: string;
        expires_at: string | null;
        last_error: string | null;
        connected_by: string | null;
        connected_at: string | null;
      }>();
    const divs = await db
      .prepare(
        `SELECT id, connection_id, exact_division, name, base_currency, sync_enabled
         FROM divisions ORDER BY exact_division`,
      )
      .all<{
        id: number;
        connection_id: number;
        exact_division: number;
        name: string;
        base_currency: string;
        sync_enabled: number;
      }>();
    const configured = loadExactConfig(ctx.env, ctx.config.appOrigin).ok;
    return json({
      exactConfigured: configured,
      connections: results.map((c) => ({
        kind: c.kind,
        name: c.name,
        status: c.status,
        expiresAt: c.expires_at,
        lastError: c.last_error,
        connectedBy: c.connected_by,
        connectedAt: c.connected_at,
        divisions: divs.results
          .filter((d) => d.connection_id === c.id)
          .map((d) => ({
            id: d.id,
            division: d.exact_division,
            name: d.name,
            currency: d.base_currency,
            syncEnabled: d.sync_enabled === 1,
          })),
      })),
    });
  });

  router.add("GET", "/api/connections/exact/start", ADMIN_STEP_UP, async (ctx) => {
    const cfg = exactConfig(ctx);
    if ("response" in cfg) return cfg.response;
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const state = randomBase64Url(32);
    const sealed = await sealFlow(ctx.config.sessionSecret, {
      state,
      nonce: randomBase64Url(16), // unused by Exact; keeps the shared cookie shape
      verifier: "",
      stepUp: true,
      returnTo: RETURN_TO,
      bind: session.email,
      exp: ctx.nowMs + FLOW_TTL_SECONDS * 1000,
      ...(ctx.url.searchParams.get("confirm_replace") === "1" ? { confirmReplace: true } : {}),
    });
    const headers = new Headers({
      location: authorizeUrl(
        DEFAULT_EXACT_HOST,
        cfg.config.clientId,
        cfg.config.redirectUri,
        state,
      ),
      "cache-control": "no-store",
    });
    headers.append("set-cookie", setCookie(EXACT_FLOW_COOKIE, sealed, FLOW_TTL_SECONDS));
    return new Response(null, { status: 302, headers });
  });

  router.add("GET", "/api/connections/exact/callback", ADMIN, async (ctx) => {
    const cfg = exactConfig(ctx);
    if ("response" in cfg) return cfg.response;
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const db = ctx.env.DB;

    const flow = await openFlow(
      ctx.config.sessionSecret,
      parseCookies(ctx.request.headers.get("cookie")).get(EXACT_FLOW_COOKIE),
      ctx.nowMs,
    );
    const state = ctx.url.searchParams.get("state");
    const code = ctx.url.searchParams.get("code");
    if (!flow || !state || !(await safeEqual(state, flow.state))) {
      console.warn("exact connect denied", "bad_state");
      return back("denied");
    }
    // The flow belongs to the admin who started it (step-up happened then).
    if (flow.bind !== session.email) {
      console.warn("exact connect denied", "wrong_user");
      return back("denied");
    }
    // Single use, claimed before the code is spent.
    const claimed = await claimOnceAndPurge(db, await sha256Hex(flow.state), FLOW_SCOPE, {
      nowMs: ctx.nowMs,
      retentionMs: FLOW_KEY_RETENTION_MS,
      purgeLimit: PURGE_BATCH,
    });
    if (!claimed) {
      console.warn("exact connect denied", "flow_replayed");
      return back("denied");
    }
    if (ctx.url.searchParams.has("error") || !code) {
      console.warn("exact connect denied", "exact_error");
      return back("denied");
    }

    let tokens;
    try {
      tokens = await exchangeCode(
        {
          host: DEFAULT_EXACT_HOST,
          clientId: cfg.config.clientId,
          clientSecret: cfg.config.clientSecret,
        },
        code,
        cfg.config.redirectUri,
      );
    } catch (e) {
      console.warn(
        "exact code exchange failed",
        e instanceof TokenEndpointError ? e.failure : "error",
      );
      return back("error");
    }

    // The ciphertext is bound to the connection id, so make sure the (single) row exists first.
    // An empty 'pending' placeholder carries no data and needs no audit row of its own.
    await db
      .prepare(
        `INSERT INTO connections (kind, name, status) VALUES ('exact', ?1, 'pending')
         ON CONFLICT (kind, name) DO NOTHING`,
      )
      .bind(EXACT_CONNECTION_NAME)
      .run();
    const row = await db
      .prepare(
        "SELECT id, status, exact_identity FROM connections WHERE kind = 'exact' AND name = ?1",
      )
      .bind(EXACT_CONNECTION_NAME)
      .first<{ id: number; status: string; exact_identity: string | null }>();
    if (!row) return back("error");
    const knownDivisions = (
      await db
        .prepare("SELECT exact_division FROM divisions WHERE connection_id = ?1")
        .bind(row.id)
        .all<{ exact_division: number }>()
    ).results.map((d) => d.exact_division);

    const key = ctx.env.TOKEN_ENC_KEY;
    const accessEnc = await encryptToken(key, tokens.accessToken, aad(row.id, "access"));
    const refreshEnc = await encryptToken(key, tokens.refreshToken, aad(row.id, "refresh"));
    const expiresAt = new Date(ctx.nowMs + tokens.expiresInS * 1000).toISOString();
    const nowIso = new Date(ctx.nowMs).toISOString();
    await db.batch([
      auditStatement(db, {
        actorEmail: session.email,
        action: "connection.exact_connected",
        entity: "connection",
        entityId: row.id,
        before: { status: row.status },
        after: { status: "active", host: DEFAULT_EXACT_HOST },
      }),
      db
        .prepare(
          `UPDATE connections
           SET status = 'active', access_token_enc = ?2, refresh_token_enc = ?3, expires_at = ?4,
               region_host = ?5, last_error = NULL, token_ref = NULL, connected_by = ?6,
               connected_at = ?7, updated_at = ?7
           WHERE id = ?1`,
        )
        .bind(row.id, accessEnc, refreshEnc, expiresAt, DEFAULT_EXACT_HOST, session.email, nowIso),
    ]);

    // Learn the division through the gate (the same path every later call takes).
    let me: CurrentMe | null = null;
    try {
      me = await fetchCurrentMe(createCurrentGateTransport(ctx.env), { jobId: "exact-connect" });
    } catch (e) {
      console.warn("exact current/Me failed", e instanceof Error ? e.name : "error");
    }
    if (!me) return back("connected_no_division");

    const identity = await exactIdentity(me);
    const different = isDifferentAccount(
      { identity: row.exact_identity, divisions: knownDivisions },
      { identity, division: me.currentDivision },
    );
    const short = (v: string | null): string | null => (v === null ? null : v.slice(0, 12));
    // New divisions start disabled, except the first one of a connection with none enabled.
    const upsertDivision = db
      .prepare(
        `INSERT INTO divisions (connection_id, exact_division, name, sync_enabled)
         VALUES (?1, ?2, ?3, CASE WHEN EXISTS
           (SELECT 1 FROM divisions WHERE connection_id = ?1 AND sync_enabled = 1) THEN 0 ELSE 1 END)
         ON CONFLICT (connection_id, exact_division) DO UPDATE SET name = excluded.name`,
      )
      .bind(row.id, me.currentDivision, divisionName(me));

    if (different && flow.confirmReplace !== true) {
      // Refuse: take the new sign-in out again; the old identity and divisions stay as they were.
      await db.batch([
        auditStatement(db, {
          actorEmail: session.email,
          action: "connection.exact_account_mismatch",
          entity: "connection",
          entityId: row.id,
          before: { identity: short(row.exact_identity) },
          after: { identity: short(identity), division: me.currentDivision, refused: true },
        }),
        db
          .prepare(
            `UPDATE connections
             SET status = 'disabled', last_error = 'different_exact_account',
                 access_token_enc = NULL, refresh_token_enc = NULL, token_ref = NULL,
                 expires_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?1`,
          )
          .bind(row.id),
      ]);
      console.warn("exact connect refused", "different_exact_account");
      return back("different_exact_account");
    }

    if (different) {
      await db.batch([
        auditStatement(db, {
          actorEmail: session.email,
          action: "connection.exact_account_replaced",
          entity: "connection",
          entityId: row.id,
          before: { identity: short(row.exact_identity), divisions: knownDivisions },
          after: { identity: short(identity), division: me.currentDivision, confirmed: true },
        }),
        db.prepare("UPDATE divisions SET sync_enabled = 0 WHERE connection_id = ?1").bind(row.id),
        upsertDivision,
        db
          .prepare(
            "UPDATE divisions SET sync_enabled = 1 WHERE connection_id = ?1 AND exact_division = ?2",
          )
          .bind(row.id, me.currentDivision),
        db
          .prepare("UPDATE connections SET exact_identity = ?2 WHERE id = ?1")
          .bind(row.id, identity),
      ]);
      return back("connected");
    }

    await db.batch([
      upsertDivision,
      // Remember who this is (fills in connections made before identities were stored).
      db
        .prepare(
          "UPDATE connections SET exact_identity = COALESCE(?2, exact_identity) WHERE id = ?1",
        )
        .bind(row.id, identity),
      auditStatement(db, {
        actorEmail: session.email,
        action: "connection.exact_divisions_synced",
        entity: "connection",
        entityId: row.id,
        after: { divisions: [me.currentDivision] },
      }),
    ]);
    return back("connected");
  });

  router.add("POST", "/api/connections/exact/disconnect", ADMIN_STEP_UP, async (ctx) => {
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const db = ctx.env.DB;
    const before = await db
      .prepare("SELECT id, status FROM connections WHERE kind = 'exact' ORDER BY id LIMIT 1")
      .first<{ id: number; status: string }>();
    const results = await db.batch([
      auditStatement(
        db,
        {
          actorEmail: session.email,
          action: "connection.exact_disconnected",
          entity: "connection",
          entityId: before?.id ?? null,
          before: { status: before?.status ?? null },
          after: { status: "disabled" },
        },
        {
          sql: "EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND status IN ('active','needs_reauth','expired'))",
          binds: [before?.id ?? 0],
        },
      ),
      db
        .prepare(
          `UPDATE connections
         SET status = 'disabled', access_token_enc = NULL, refresh_token_enc = NULL, token_ref = NULL,
             expires_at = NULL, last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND status IN ('active','needs_reauth','expired')`,
        )
        .bind(before?.id ?? 0),
    ]);
    // Idempotent: disconnecting what is already disconnected changes nothing and audits nothing.
    return json({ ok: true, changed: (results[1]?.meta.changes ?? 0) === 1 });
  });
}
