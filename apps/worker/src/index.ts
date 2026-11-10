import { ensureSeeded } from "./db/seed";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  INITIAL_ADMIN_EMAIL: string;
  ALLOWED_HD: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ensureSeeded(env);
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
    await ensureSeeded(env);
  },
} satisfies ExportedHandler<Env>;
