/**
 * Exact connection routes (admin only where it changes anything). Connecting needs a fresh Google
 * sign-in (CLAUDE.md 4.0 step-up) when the flow starts; the callback is a browser navigation, so
 * it instead requires the same admin session that started the flow (the signed round-trip cookie
 * is bound to that email) and answers with redirects, never JSON error pages.
 *
 * Every change is one db.batch of the change plus its audit row (ADR 0013). Tokens are encrypted
 * before they are stored and never appear in a response, a log line or an audit row.
 */
import { auditStatement } from "../db/audit";
import { claimOnceAndPurge } from "../db/idempotency";
import { clearCookie, EXACT_FLOW_COOKIE, parseCookies, setCookie } from "../auth/cookies";
import { randomBase64Url, safeEqual, sha256Hex } from "../auth/crypto";
import { FLOW_TTL_SECONDS, openFlow, sealFlow } from "../auth/flow-cookie";
import { json, type Ctx, type Router } from "../router";
import { encryptToken } from "../crypto/token-crypto";
import { DEFAULT_EXACT_HOST, loadExactConfig, type ExactConfig } from "./config";
import { createGateTransport } from "./gate-transport";
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

/** What Exact's /current/Me answers, reduced to what we store. */
export function parseMe(body: string): { division: number; name: string } | null {
  try {
    const v = JSON.parse(body) as { d?: unknown };
    const d = v.d as { results?: unknown } | unknown[] | undefined;
    const first = Array.isArray(d)
      ? d[0]
      : d && Array.isArray((d as { results?: unknown }).results)
        ? ((d as { results: unknown[] }).results[0] as unknown)
        : undefined;
    if (!first || typeof first !== "object") return null;
    const rec = first as Record<string, unknown>;
    const division = Number(rec.CurrentDivision);
    if (!Number.isSafeInteger(division) || division < 1) return null;
    const rawName = rec.DivisionCustomerName;
    const name =
      typeof rawName === "string" && rawName.trim() !== ""
        ? rawName.trim().slice(0, 200)
        : `Division ${division}`;
    return { division, name };
  } catch {
    return null;
  }
}

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
        "SELECT connection_id, exact_division, name, base_currency FROM divisions ORDER BY exact_division",
      )
      .all<{
        connection_id: number;
        exact_division: number;
        name: string;
        base_currency: string;
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
          .map((d) => ({ division: d.exact_division, name: d.name, currency: d.base_currency })),
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
      .prepare("SELECT id, status FROM connections WHERE kind = 'exact' AND name = ?1")
      .bind(EXACT_CONNECTION_NAME)
      .first<{ id: number; status: string }>();
    if (!row) return back("error");

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
    let me: { division: number; name: string } | null = null;
    try {
      const res = await createGateTransport(
        ctx.env,
        0,
      )({
        method: "GET",
        path: "/Me",
        division: 0,
        priority: "user",
        jobId: "exact-connect",
        api: "rest",
      });
      me = res.status === 200 ? parseMe(res.body) : null;
    } catch (e) {
      console.warn("exact current/Me failed", e instanceof Error ? e.name : "error");
    }
    if (!me) return back("connected_no_division");

    await db.batch([
      db
        .prepare(
          `INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, ?2, ?3)
           ON CONFLICT (connection_id, exact_division) DO UPDATE SET name = excluded.name`,
        )
        .bind(row.id, me.division, me.name),
      auditStatement(db, {
        actorEmail: session.email,
        action: "connection.exact_divisions_synced",
        entity: "connection",
        entityId: row.id,
        after: { divisions: [me.division] },
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
    if ((results[0]?.meta.changes ?? 0) !== 1) return json({ error: "not_connected" }, 409);
    return json({ ok: true });
  });
}
