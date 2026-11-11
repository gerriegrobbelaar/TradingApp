import { registerAuthRoutes } from "./auth/routes";
import { registerUserRoutes } from "./auth/users-routes";
import { registerExactRoutes } from "./exact/routes";
import { registerSyncRoutes } from "./exact/sync-routes";
import { registerReadRoutes } from "./read/routes";
import { ensureSeeded } from "./db/seed";
import { ensureDefaultJobs } from "./jobs/defaults";
import { registerJobRoutes } from "./jobs/routes";
import { handleQueue, tickScheduler } from "./jobs/runner";
import type { Env } from "./env";
import { json, Router } from "./router";

export type { Env } from "./env";
export { ExactGate } from "./exact/gate";
export { JobLock } from "./jobs/job-lock";

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
  try {
    await ensureDefaultJobs(env);
  } catch (err) {
    console.error("default jobs seed failed; will retry", err instanceof Error ? err.name : "");
  }
}

const router = new Router();
registerAuthRoutes(router);
registerUserRoutes(router);
registerExactRoutes(router);
registerSyncRoutes(router);
registerReadRoutes(router);
registerJobRoutes(router);

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

  /** Cron Trigger, every minute: claim due job runs and put them on the queue (jobs/runner.ts). */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await seedSafely(env);
    try {
      await tickScheduler(env, controller.scheduledTime);
    } catch (err) {
      console.error("scheduler tick crashed", err instanceof Error ? err.name : "");
    }
  },

  /** Queue consumer: executes the job runs the tick (or "Run now") enqueued. */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;
