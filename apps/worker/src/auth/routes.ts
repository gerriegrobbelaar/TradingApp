import { writeAudit } from "../db/audit";
import { json, type Router } from "../router";
import { clearCookie, FLOW_COOKIE, parseCookies, SESSION_COOKIE, setCookie } from "./cookies";
import { randomBase64Url, safeEqual, sha256Base64Url, sha256Hex } from "./crypto";
import { FLOW_TTL_SECONDS, openFlow, safeReturnTo, sealFlow } from "./flow-cookie";
import { AuthError, buildAuthUrl, exchangeCode, verifyIdToken } from "./google";
import {
  ABSOLUTE_CAP_MS,
  createSession,
  deleteSessionByToken,
  isStepUpFresh,
  loadSession,
} from "./session";
import { resolveUser } from "./signin";

/**
 * A step-up login must be a genuinely fresh authentication. We request prompt=login&max_age=0,
 * and OIDC requires auth_time in the ID token whenever max_age is requested, so a step-up token
 * without auth_time (or with an old one) is refused rather than trusted.
 */
const MAX_STEP_UP_AUTH_AGE_S = 5 * 60;
/** Stored as last_auth_at when Google gave no auth_time: never counts as a fresh sign-in. */
const NOT_FRESH_MS = 0;

/** Scope in idempotency_keys used to make each sign-in round trip single-use. */
const FLOW_SCOPE = "auth.flow";
const FLOW_KEY_RETENTION_MS = 24 * 3600 * 1000;
const PURGE_BATCH = 100;

function denied(clearFlow = true): Response {
  const headers = new Headers({ location: "/?auth=denied", "cache-control": "no-store" });
  if (clearFlow) headers.append("set-cookie", clearCookie(FLOW_COOKIE));
  return new Response(null, { status: 302, headers });
}

export function registerAuthRoutes(router: Router): void {
  router.addNoConfig("GET", "/api/health", () => json({ ok: true }));

  router.add("GET", "/api/auth/login", { public: true }, async (ctx) => {
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const verifier = randomBase64Url(48);
    const stepUp = ctx.url.searchParams.get("step_up") === "1";
    const sealed = await sealFlow(ctx.config.sessionSecret, {
      state,
      nonce,
      verifier,
      stepUp,
      returnTo: safeReturnTo(ctx.url.searchParams.get("return_to"), ctx.config.appOrigin),
      exp: ctx.nowMs + FLOW_TTL_SECONDS * 1000,
    });
    const location = buildAuthUrl(ctx.config, {
      state,
      nonce,
      challenge: await sha256Base64Url(verifier),
      stepUp,
    });
    const headers = new Headers({ location, "cache-control": "no-store" });
    headers.append("set-cookie", setCookie(FLOW_COOKIE, sealed, FLOW_TTL_SECONDS));
    return new Response(null, { status: 302, headers });
  });

  router.add("GET", "/api/auth/callback", { public: true }, async (ctx) => {
    const cookies = parseCookies(ctx.request.headers.get("cookie"));
    const flow = await openFlow(ctx.config.sessionSecret, cookies.get(FLOW_COOKIE), ctx.nowMs);
    const code = ctx.url.searchParams.get("code");
    const state = ctx.url.searchParams.get("state");
    try {
      if (!flow) throw new AuthError("no_flow_cookie");
      if (!state || !(await safeEqual(state, flow.state))) throw new AuthError("bad_state");
      if (ctx.url.searchParams.has("error") || !code) throw new AuthError("google_error");

      const idToken = await exchangeCode(ctx.config, code, flow.verifier);
      const identity = await verifyIdToken(ctx.config, idToken, flow.nonce, ctx.nowMs);
      const nowS = Math.floor(ctx.nowMs / 1000);
      if (flow.stepUp) {
        if (identity.authTime === undefined) throw new AuthError("step_up_no_auth_time");
        if (nowS - identity.authTime > MAX_STEP_UP_AUTH_AGE_S) {
          throw new AuthError("step_up_not_fresh");
        }
      }
      // last_auth_at is when Google says the user really authenticated, never "now". A plain
      // (possibly silent SSO) login therefore cannot refresh the step-up window.
      // (verifyIdToken already refused an auth_time beyond the clock skew; clamp to now.)
      const lastAuthMs =
        identity.authTime === undefined
          ? NOT_FRESH_MS
          : Math.min(identity.authTime * 1000, ctx.nowMs);
      const userId = await resolveUser(ctx.env.DB, identity);

      // Single use: the same callback (cookie + state) can never create a second session,
      // even if the authorization code were accepted again. Claimed only after a verified
      // ID token, so anonymous traffic cannot grow the table.
      const [claim] = await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `INSERT INTO idempotency_keys (scope, key, status, completed_at)
           VALUES (?1, ?2, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (scope, key) DO NOTHING`,
        ).bind(FLOW_SCOPE, await sha256Hex(flow.state)),
        // Opportunistic retention: a flow cookie lives 10 minutes, so day-old claims are dead
        // weight. Bounded, and only this scope (other scopes are payment keys, kept for good).
        ctx.env.DB.prepare(
          `DELETE FROM idempotency_keys WHERE rowid IN (
             SELECT rowid FROM idempotency_keys
             WHERE scope = ?1 AND created_at < ?2 LIMIT ?3)`,
        ).bind(FLOW_SCOPE, new Date(ctx.nowMs - FLOW_KEY_RETENTION_MS).toISOString(), PURGE_BATCH),
      ]);
      if (claim?.meta.changes !== 1) throw new AuthError("flow_replayed");

      // A new session per sign-in (also on step-up); the old one is dropped.
      const oldToken = cookies.get(SESSION_COOKIE);
      if (oldToken) await deleteSessionByToken(ctx.env.DB, oldToken);
      const token = await createSession(ctx.env.DB, userId, ctx.nowMs, lastAuthMs);
      await writeAudit(ctx.env.DB, {
        actorEmail: identity.email,
        action: flow.stepUp ? "auth.step_up" : "auth.login",
        entity: "user",
        entityId: userId,
      });

      const headers = new Headers({ location: flow.returnTo, "cache-control": "no-store" });
      headers.append("set-cookie", clearCookie(FLOW_COOKIE));
      headers.append("set-cookie", setCookie(SESSION_COOKIE, token, ABSOLUTE_CAP_MS / 1000));
      return new Response(null, { status: 302, headers });
    } catch (err) {
      // Reason by name only; never the token, code or email.
      console.warn("sign-in denied", err instanceof AuthError ? err.reason : "internal_error");
      return denied();
    }
  });

  // Public so an expired or unknown session still gets its cookie cleared; the router's CSRF
  // check still applies (POST), so a cross-site page cannot log the user out.
  router.add("POST", "/api/auth/logout", { public: true }, async (ctx) => {
    const token = parseCookies(ctx.request.headers.get("cookie")).get(SESSION_COOKIE);
    if (token) {
      const session = await loadSession(ctx.env.DB, token, ctx.nowMs);
      await deleteSessionByToken(ctx.env.DB, token);
      if (session) {
        await writeAudit(ctx.env.DB, {
          actorEmail: session.email,
          action: "auth.logout",
          entity: "user",
          entityId: session.userId,
        });
      }
    }
    return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
  });

  router.add("GET", "/api/auth/me", {}, (ctx) => {
    const s = ctx.session;
    if (!s) return json({ error: "unauthenticated" }, 401);
    return json({
      email: s.email,
      roles: s.roles,
      stepUpFresh: isStepUpFresh(s, ctx.nowMs),
      lastAuthAt: s.lastAuthAt,
    });
  });
}
