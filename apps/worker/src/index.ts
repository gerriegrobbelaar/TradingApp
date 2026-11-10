import { registerAuthRoutes } from "./auth/routes";
import { registerUserRoutes } from "./auth/users-routes";
import { registerExactRoutes } from "./exact/routes";
import { runScheduledExactSync } from "./exact/scheduled";
import { registerSyncRoutes } from "./exact/sync-routes";
import { ensureSeeded } from "./db/seed";
import type { Env } from "./env";
import { json, Router } from "./router";

export type { Env } from "./env";
export { ExactGate } from "./exact/gate";

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
registerExactRoutes(router);
registerSyncRoutes(router);

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

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await seedSafely(env);
    // STOPGAP until the Phase 3 scheduler (exact/scheduled.ts): hourly Exact sync.
    try {
      await runScheduledExactSync(env, controller.scheduledTime);
    } catch (err) {
      console.error("scheduled exact sync crashed", err instanceof Error ? err.name : "");
    }
  },
} satisfies ExportedHandler<Env>;
