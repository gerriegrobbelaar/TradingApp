/**
 * Exact connection routes (admin only where it changes anything). Connecting needs a fresh Google
 * sign-in (CLAUDE.md 4.0 step-up) when the flow starts; the callback is a browser navigation, so
 * it instead requires the same admin session that started the flow (the signed round-trip cookie
 * is bound to that email) and answers with redirects, never JSON error pages.
 *
 * Every change is one db.batch of the change plus its audit row (ADR 0013). Tokens are encrypted
 * before they are stored and never appear in a response, a log line or an audit row.
 *
 * Reconnecting to a DIFFERENT Exact account (review S7, ADR 0016 item 21, ADR 0019): the new
 * tokens are staged with status 'pending' (nothing but GET /current/Me can use them), then the
 * callback compares the account /current/Me reports with the connection's history
 * (`isDifferentAccount`). If it differs, nothing is replaced unless the flow was started with
 * `confirm_replace=1` (admin + step-up at the start, carried in the signed single-use flow
 * cookie): the staged sign-in is removed again (connection disabled, old identity and divisions
 * kept) and the callback answers `?exact=different_exact_account`. With the confirmation the old
 * divisions are switched off for syncing and the new account's current division is enabled. If
 * /current/Me cannot be read for a connection with history, the sign-in is removed as well
 * (`?exact=unverified`): an unverified account is never activated.
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
import { loadRevolutConfig } from "../revolut/config";
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

export const DIFFERENT_EXACT_ACCOUNT = "different_exact_account";

/**
 * Identity of the Exact account (the customer that owns the current division) behind a
 * /current/Me answer: `id:<sha256>` of the `DivisionCustomer` GUID when Exact sends one (stable),
 * else `name:<sha256>` of the lower-cased customer name (NOT stable: a rename in Exact changes
 * it), else null. Only the hash is stored; audit rows carry `shortIdentity`.
 */
export async function exactIdentity(me: CurrentMe): Promise<string | null> {
  if (me.divisionCustomerId !== null) {
    return `id:${await sha256Hex(`exact-account:${me.divisionCustomerId.toLowerCase()}`)}`;
  }
  const name = (me.divisionCustomerName ?? "").trim().toLowerCase().slice(0, 200);
  return name === "" ? null : `name:${await sha256Hex(`exact-account:${name}`)}`;
}

/** Kind plus the first 12 hex characters, for audit rows. */
export const shortIdentity = (v: string | null): string | null => {
  if (v === null) return null;
  const i = v.indexOf(":");
  return i < 0 ? v.slice(0, 12) : `${v.slice(0, i)}:${v.slice(i + 1, i + 13)}`;
};

/** The identity to store after a successful connect: never downgrade a stable id to a name. */
export function keepIdentity(prior: string | null, next: string | null): string | null {
  if (next === null) return prior;
  if (prior !== null && prior.startsWith("id:") && !next.startsWith("id:")) return prior;
  return next;
}

/**
 * True when the account behind `me` is not the one this connection was used with:
 *  1. a connection with no history (no identity, no division) is never "different";
 *  2. a current division we already know is the same data whatever the identity says, so a
 *     company RENAME (which changes a name-based identity) never locks the admin out;
 *  3. otherwise (a division we have never seen) only two equal identities of the same kind make
 *     it the same account; two different stable ids, a name, or an unknown side mean different.
 */
export function isDifferentAccount(
  prior: { identity: string | null; divisions: readonly number[] },
  next: { identity: string | null; division: number },
): boolean {
  if (prior.identity === null && prior.divisions.length === 0) return false;
  if (prior.divisions.includes(next.division)) return false;
  return prior.identity === null || next.identity === null || prior.identity !== next.identity;
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
        `SELECT id, kind, name, status, expires_at, last_error, connected_by, connected_at,
           revolut_environment, creates_bank_entries, payments_mode, bank_entries_decided_at
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
        revolut_environment: string | null;
        creates_bank_entries: number;
        payments_mode: string;
        bank_entries_decided_at: string | null;
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
      revolutConfigured: loadRevolutConfig(ctx.env, ctx.config.appOrigin).ok,
      connections: results.map((c) => ({
        kind: c.kind,
        name: c.name,
        status: c.status,
        expiresAt: c.expires_at,
        lastError: c.last_error,
        connectedBy: c.connected_by,
        connectedAt: c.connected_at,
        // Revolut only: the two settings and the environment, never a token or key. `null` for
        // createsBankEntries means the admin has not decided yet.
        ...(c.kind === "revolut"
          ? {
              revolut: {
                environment: c.revolut_environment,
                createsBankEntries:
                  c.bank_entries_decided_at === null ? null : c.creates_bank_entries === 1,
                paymentsMode: c.payments_mode,
              },
            }
          : {}),
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
    // creates_bank_entries is explicit (migration 0012, review S11): the Exact connection never
    // creates bank entries itself; the per-connection decision belongs to Revolut (Phase 5).
    await db
      .prepare(
        `INSERT INTO connections (kind, name, status, creates_bank_entries)
         VALUES ('exact', ?1, 'pending', 0)
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
    // Stage the new tokens as 'pending': the scheduler, the sync and every division gate refuse a
    // pending connection, and the gate serves it for GET /current/Me only. So until /Me proved
    // which account signed in, no call for our divisions can run with the new tokens.
    await db.batch([
      auditStatement(db, {
        actorEmail: session.email,
        action: "connection.exact_authorized",
        entity: "connection",
        entityId: row.id,
        before: { status: row.status },
        after: { status: "pending", host: DEFAULT_EXACT_HOST },
      }),
      db
        .prepare(
          `UPDATE connections
           SET status = 'pending', access_token_enc = ?2, refresh_token_enc = ?3, expires_at = ?4,
               region_host = ?5, last_error = NULL, token_ref = NULL, updated_at = ?6
           WHERE id = ?1`,
        )
        .bind(row.id, accessEnc, refreshEnc, expiresAt, DEFAULT_EXACT_HOST, nowIso),
    ]);

    // Every later statement only acts while the staged tokens are still OURS: a second callback
    // running at the same time (another flow) must not have its tokens activated by this one.
    // The refresh ciphertext is unique (random IV), so it identifies this callback's tokens.
    const mine = (enc: string, id = "?1"): string =>
      `EXISTS (SELECT 1 FROM connections WHERE id = ${id} AND status = 'pending'
               AND refresh_token_enc = ${enc})`;
    const wipe = (lastError: string): D1PreparedStatement =>
      db
        .prepare(
          `UPDATE connections
           SET status = 'disabled', last_error = ?2,
               access_token_enc = NULL, refresh_token_enc = NULL, token_ref = NULL,
               expires_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?1 AND ${mine("?3")}`,
        )
        .bind(row.id, lastError, refreshEnc);
    const hasHistory = row.exact_identity !== null || knownDivisions.length > 0;

    // Learn the account and division through the gate (the same path every later call takes).
    let me: CurrentMe | null = null;
    try {
      me = await fetchCurrentMe(createCurrentGateTransport(ctx.env), { jobId: "exact-connect" });
    } catch (e) {
      console.warn("exact current/Me failed", e instanceof Error ? e.name : "error");
    }
    if (!me) {
      if (hasHistory) {
        // We cannot tell whether this is the account the connection was used with: fail closed.
        // The admin simply connects again; nothing else (identity, divisions) changes.
        await db.batch([
          auditStatement(
            db,
            {
              actorEmail: session.email,
              action: "connection.exact_account_unverified",
              entity: "connection",
              entityId: row.id,
              after: { status: "disabled", refused: true },
            },
            { sql: mine("?7", "?8"), binds: [refreshEnc, row.id] },
          ),
          wipe("account_unverified"),
        ]);
        console.warn("exact connect refused", "account_unverified");
        return back("unverified");
      }
      // A first connection has nothing to compare with: it is used as it is.
      const results = await db.batch([
        auditStatement(
          db,
          {
            actorEmail: session.email,
            action: "connection.exact_connected",
            entity: "connection",
            entityId: row.id,
            before: { status: "pending" },
            after: { status: "active", division: null },
          },
          { sql: mine("?7", "?8"), binds: [refreshEnc, row.id] },
        ),
        db
          .prepare(
            `UPDATE connections SET status = 'active', connected_by = ?2, connected_at = ?3,
               updated_at = ?3
             WHERE id = ?1 AND ${mine("?4")}`,
          )
          .bind(row.id, session.email, nowIso, refreshEnc),
      ]);
      return (results[1]?.meta.changes ?? 0) === 1 ? back("connected_no_division") : back("error");
    }

    const identity = await exactIdentity(me);
    const different = isDifferentAccount(
      { identity: row.exact_identity, divisions: knownDivisions },
      { identity, division: me.currentDivision },
    );
    const short = shortIdentity;
    const guard = { sql: mine("?7", "?8"), binds: [refreshEnc, row.id] };

    if (different && flow.confirmReplace !== true) {
      // Refuse: take the new sign-in out again; the old identity and divisions stay as they were.
      await db.batch([
        auditStatement(
          db,
          {
            actorEmail: session.email,
            action: "connection.exact_account_mismatch",
            entity: "connection",
            entityId: row.id,
            before: { identity: short(row.exact_identity) },
            after: { identity: short(identity), division: me.currentDivision, refused: true },
          },
          guard,
        ),
        wipe(DIFFERENT_EXACT_ACCOUNT),
      ]);
      console.warn("exact connect refused", DIFFERENT_EXACT_ACCOUNT);
      return back(DIFFERENT_EXACT_ACCOUNT);
    }

    // New divisions start disabled, except the first one of a connection with none enabled.
    const upsertDivision = db
      .prepare(
        `INSERT INTO divisions (connection_id, exact_division, name, sync_enabled)
         SELECT ?1, ?2, ?3, CASE WHEN EXISTS
           (SELECT 1 FROM divisions WHERE connection_id = ?1 AND sync_enabled = 1) THEN 0 ELSE 1 END
         WHERE ${mine("?4")}
         ON CONFLICT (connection_id, exact_division) DO UPDATE SET name = excluded.name`,
      )
      .bind(row.id, me.currentDivision, divisionName(me), refreshEnc);
    // Activation comes LAST in the batch: every guarded statement before it still sees 'pending'.
    const activate = db
      .prepare(
        `UPDATE connections
         SET status = 'active', connected_by = ?2, connected_at = ?3, updated_at = ?3,
             exact_identity = ?4
         WHERE id = ?1 AND ${mine("?5")}`,
      )
      .bind(row.id, session.email, nowIso, keepIdentity(row.exact_identity, identity), refreshEnc);
    const connectedAudit = auditStatement(
      db,
      {
        actorEmail: session.email,
        action: "connection.exact_connected",
        entity: "connection",
        entityId: row.id,
        before: { status: "pending" },
        after: { status: "active", division: me.currentDivision },
      },
      guard,
    );

    if (different) {
      const results = await db.batch([
        auditStatement(
          db,
          {
            actorEmail: session.email,
            action: "connection.exact_account_replaced",
            entity: "connection",
            entityId: row.id,
            before: { identity: short(row.exact_identity), divisions: knownDivisions },
            after: { identity: short(identity), division: me.currentDivision, confirmed: true },
          },
          guard,
        ),
        connectedAudit,
        db
          .prepare(
            `UPDATE divisions SET sync_enabled = 0 WHERE connection_id = ?1 AND ${mine("?2")}`,
          )
          .bind(row.id, refreshEnc),
        upsertDivision,
        db
          .prepare(
            `UPDATE divisions SET sync_enabled = 1
             WHERE connection_id = ?1 AND exact_division = ?2 AND ${mine("?3")}`,
          )
          .bind(row.id, me.currentDivision, refreshEnc),
        db
          .prepare(
            `UPDATE connections
             SET status = 'active', connected_by = ?2, connected_at = ?3, updated_at = ?3,
                 exact_identity = ?4
             WHERE id = ?1 AND ${mine("?5")}`,
          )
          .bind(row.id, session.email, nowIso, identity, refreshEnc),
      ]);
      return (results[5]?.meta.changes ?? 0) === 1 ? back("connected") : back("error");
    }

    const results = await db.batch([
      connectedAudit,
      upsertDivision,
      auditStatement(
        db,
        {
          actorEmail: session.email,
          action: "connection.exact_divisions_synced",
          entity: "connection",
          entityId: row.id,
          after: { divisions: [me.currentDivision] },
        },
        guard,
      ),
      // Remember who this is (fills in connections made before identities were stored).
      activate,
    ]);
    return (results[3]?.meta.changes ?? 0) === 1 ? back("connected") : back("error");
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
          sql: `EXISTS (SELECT 1 FROM connections WHERE id = ?7 AND (status IN ('active','needs_reauth','expired')
                  OR (status = 'pending' AND refresh_token_enc IS NOT NULL)))`,
          binds: [before?.id ?? 0],
        },
      ),
      db
        .prepare(
          `UPDATE connections
         SET status = 'disabled', access_token_enc = NULL, refresh_token_enc = NULL, token_ref = NULL,
             expires_at = NULL, last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1 AND (status IN ('active','needs_reauth','expired')
                            OR (status = 'pending' AND refresh_token_enc IS NOT NULL))`,
        )
        .bind(before?.id ?? 0),
    ]);
    // Idempotent: disconnecting what is already disconnected changes nothing and audits nothing.
    return json({ ok: true, changed: (results[1]?.meta.changes ?? 0) === 1 });
  });
}
