/**
 * Small router with default-deny access control. Every route must declare its access:
 *  - `{ public: true }`: no session needed (health, login, callback);
 *  - otherwise a valid session is required, optionally restricted to `roles` (any of them;
 *    roles are not hierarchical) and optionally to a fresh Google sign-in (`stepUp`).
 * State-changing methods additionally pass the CSRF check (see `csrfOk`).
 */
import { loadAuthConfig, type AuthConfig } from "./auth/config";
import { parseCookies, SESSION_COOKIE } from "./auth/cookies";
import { isStepUpFresh, loadSession, type Role, type Session } from "./auth/session";
import type { Env } from "./env";

export interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  config: AuthConfig;
  /** Null only on public routes. */
  session: Session | null;
  nowMs: number;
}

/** Context for routes that must work without a valid auth configuration (health). */
export type NoConfigCtx = Omit<Ctx, "config"> & { config: AuthConfig | null };

export type Handler = (ctx: Ctx) => Promise<Response> | Response;
export type NoConfigHandler = (ctx: NoConfigCtx) => Promise<Response> | Response;

export interface Access {
  public?: true;
  /**
   * Skips the CSRF-header rule. Only for PUBLIC routes that authenticate each request another way
   * (the Revolut webhook: HMAC signature). Registering it on a non-public route throws.
   */
  csrfExempt?: true;
  roles?: readonly Role[];
  stepUp?: true;
}

type Route = {
  method: string;
  /** "METHOD /path/:param" as registered; safe to log (no request data). */
  pattern: string;
  segments: string[];
  access: Access;
} & ({ noConfig: false; handler: Handler } | { noConfig: true; handler: NoConfigHandler });

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** API JSON is never cached and never sniffed into another content type. */
export const json = (body: unknown, status = 200, headers?: HeadersInit): Response => {
  const h = new Headers(headers);
  h.set("cache-control", "no-store");
  h.set("x-content-type-options", "nosniff");
  return Response.json(body, { status, headers: h });
};

/**
 * CSRF defence for cookie sessions: every unsafe request must carry the custom header
 * `X-Requested-With` (a cross-site form or simple fetch cannot set it without a CORS preflight,
 * which we never grant), and if the browser sent an Origin it must be the app's own origin.
 */
export function csrfOk(request: Request, appOrigin: string): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  if ((request.headers.get("x-requested-with") ?? "").trim() === "") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === appOrigin;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, access: Access, handler: Handler): this {
    if (access.csrfExempt && !access.public) {
      throw new Error("csrfExempt is only allowed on public routes");
    }
    this.routes.push({
      method,
      pattern: `${method} ${path}`,
      segments: path.split("/").filter(Boolean),
      access,
      noConfig: false,
      handler,
    });
    return this;
  }

  /** Public route that still works when the auth configuration is incomplete (health only). */
  addNoConfig(method: string, path: string, handler: NoConfigHandler): this {
    this.routes.push({
      method,
      pattern: `${method} ${path}`,
      segments: path.split("/").filter(Boolean),
      access: { public: true },
      noConfig: true,
      handler,
    });
    return this;
  }

  /** What is registered, for tests that pin the access rules (no handlers, no request data). */
  describe(): { pattern: string; access: Access }[] {
    return this.routes.map((r) => ({ pattern: r.pattern, access: r.access }));
  }

  private match(
    method: string,
    pathname: string,
  ): { route: Route; params: Record<string, string> } | "method" | null {
    const parts = pathname.split("/").filter(Boolean);
    let pathHit = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i] as string;
        const part = parts[i] as string;
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathHit = true;
      if (route.method === method) return { route, params };
    }
    return pathHit ? "method" : null;
  }

  /** Returns null when no route matches the path so the caller can fall through. */
  async handle(request: Request, env: Env, nowMs = Date.now()): Promise<Response | null> {
    const url = new URL(request.url);
    let m;
    try {
      m = this.match(request.method, url.pathname);
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    if (m === null) return null;
    if (m === "method") return json({ error: "method_not_allowed" }, 405);
    const { route, params } = m;
    try {
      return await this.dispatch(route, params, request, url, env, nowMs);
    } catch (err) {
      // Error name and route pattern only: never the message, URL or body, which may carry
      // tokens, IBANs or emails (CLAUDE.md 5).
      console.error("unhandled error", err instanceof Error ? err.name : "unknown", route.pattern);
      return json({ error: "internal_error" }, 500);
    }
  }

  private async dispatch(
    route: Route,
    params: Record<string, string>,
    request: Request,
    url: URL,
    env: Env,
    nowMs: number,
  ): Promise<Response> {
    const cfg = loadAuthConfig(env);
    if (!cfg.ok && !route.noConfig) {
      // Names of the missing settings only, never values.
      console.error("auth configuration incomplete", cfg.missing.join(","));
      return json({ error: "server_misconfigured" }, 500);
    }

    if (cfg.ok && !route.access.csrfExempt && !csrfOk(request, cfg.config.appOrigin)) {
      return json({ error: "csrf" }, 403);
    }

    let session: Session | null = null;
    if (!route.access.public) {
      const token = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
      session = token ? await loadSession(env.DB, token, nowMs) : null;
      if (!session) return json({ error: "unauthenticated" }, 401);
      const roles = route.access.roles;
      if (roles && !roles.some((r) => session?.roles.includes(r))) {
        return json({ error: "forbidden" }, 403);
      }
      if (route.access.stepUp && !isStepUpFresh(session, nowMs)) {
        return json({ error: "step_up_required" }, 401);
      }
    }
    const base = { request, env, url, params, session, nowMs };
    if (route.noConfig) return route.handler({ ...base, config: cfg.ok ? cfg.config : null });
    if (!cfg.ok) return json({ error: "server_misconfigured" }, 500); // unreachable; narrows type
    return route.handler({ ...base, config: cfg.config });
  }
}
