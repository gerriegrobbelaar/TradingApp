import { writeAudit } from "../db/audit";
import { json, type Router } from "../router";
import { clearCookie, FLOW_COOKIE, parseCookies, SESSION_COOKIE, setCookie } from "./cookies";
import { randomBase64Url, safeEqual, sha256Base64Url } from "./crypto";
import { FLOW_TTL_SECONDS, openFlow, safeReturnTo, sealFlow } from "./flow-cookie";
import { AuthError, buildAuthUrl, exchangeCode, verifyIdToken } from "./google";
import { ABSOLUTE_CAP_MS, createSession, deleteSessionByToken, isStepUpFresh } from "./session";
import { resolveUser } from "./signin";

/** A step-up login must be a genuinely fresh authentication when Google reports auth_time. */
const MAX_STEP_UP_AUTH_AGE_S = 5 * 60;

function denied(clearFlow = true): Response {
  const headers = new Headers({ location: "/?auth=denied", "cache-control": "no-store" });
  if (clearFlow) headers.append("set-cookie", clearCookie(FLOW_COOKIE));
  return new Response(null, { status: 302, headers });
}

export function registerAuthRoutes(router: Router): void {
  router.add("GET", "/api/health", { public: true, noConfig: true }, () => json({ ok: true }));

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
      returnTo: safeReturnTo(ctx.url.searchParams.get("return_to")),
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
      if (
        flow.stepUp &&
        identity.authTime !== undefined &&
        ctx.nowMs / 1000 - identity.authTime > MAX_STEP_UP_AUTH_AGE_S
      ) {
        throw new AuthError("step_up_not_fresh");
      }
      const userId = await resolveUser(ctx.env.DB, identity);

      // A new session per sign-in (also on step-up); the old one is dropped.
      const oldToken = cookies.get(SESSION_COOKIE);
      if (oldToken) await deleteSessionByToken(ctx.env.DB, oldToken);
      const token = await createSession(ctx.env.DB, userId, ctx.nowMs);
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

  router.add("POST", "/api/auth/logout", {}, async (ctx) => {
    const token = parseCookies(ctx.request.headers.get("cookie")).get(SESSION_COOKIE);
    if (token) await deleteSessionByToken(ctx.env.DB, token);
    if (ctx.session) {
      await writeAudit(ctx.env.DB, {
        actorEmail: ctx.session.email,
        action: "auth.logout",
        entity: "user",
        entityId: ctx.session.userId,
      });
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
