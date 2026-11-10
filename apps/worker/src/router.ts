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

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

export interface Access {
  public?: true;
  /** Skip the auth configuration check (health only). */
  noConfig?: true;
  roles?: readonly Role[];
  stepUp?: true;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  access: Access;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const json = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  Response.json(body, { status, ...(headers ? { headers } : {}) });

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
    this.routes.push({ method, segments: path.split("/").filter(Boolean), handler, access });
    return this;
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

    const cfg = loadAuthConfig(env);
    if (!cfg.ok && !route.access.noConfig) {
      // Names of the missing settings only, never values.
      console.error("auth configuration incomplete", cfg.missing.join(","));
      return json({ error: "server_misconfigured" }, 500);
    }
    const config = cfg.ok ? cfg.config : (null as unknown as AuthConfig);

    if (cfg.ok && !csrfOk(request, config.appOrigin)) return json({ error: "csrf" }, 403);

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
    return route.handler({ request, env, url, params, config, session, nowMs });
  }
}
