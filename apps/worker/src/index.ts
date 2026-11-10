import { registerAuthRoutes } from "./auth/routes";
import { registerUserRoutes } from "./auth/users-routes";
import { ensureSeeded } from "./db/seed";
import type { Env } from "./env";
import { json, Router } from "./router";

export type { Env } from "./env";

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

const router = new Router();
registerAuthRoutes(router);
registerUserRoutes(router);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await seedSafely(env);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      // Default deny: unknown API paths are 404, known ones go through the router's access rules.
      return (await router.handle(request, env)) ?? json({ error: "not_found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await seedSafely(env);
  },
} satisfies ExportedHandler<Env>;
