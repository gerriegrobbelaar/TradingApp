import { ensureSeeded } from "./db/seed";

/**
 * A failed seed (transient D1 error, bad INITIAL_ADMIN_EMAIL) must not take the app down; it is
 * retried on the next request. The email itself is never logged.
 */
async function seedSafely(env: Env): Promise<void> {
  try {
    await ensureSeeded(env);
  } catch (err) {
    console.error("initial admin seed failed; will retry", err instanceof Error ? err.name : "");
  }
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  INITIAL_ADMIN_EMAIL: string;
  ALLOWED_HD: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await seedSafely(env);
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await seedSafely(env);
  },
} satisfies ExportedHandler<Env>;
