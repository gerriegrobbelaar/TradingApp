/**
 * Administration (division) list and switcher, and manual sync.
 *
 *  GET  /api/divisions            any signed-in role: divisions, the user's selection, last sync
 *  PUT  /api/me/division          any signed-in role: remember the chosen division (validated)
 *  POST /api/divisions/:id/sync   admin or finance: run one time-boxed SLICE of a sync inline (no
 *                                 step-up). Body `{ mode?: "full" | "incremental",
 *                                 restart?: true, allowLargeClose?: true }`. A slice makes
 *                                 guaranteed progress and answers `partial` with progress counts
 *                                 when it has not finished; the next call continues it. Manual
 *                                 full slices do not read IBANs (the nightly run does).
 *                                 One new run per division per MANUAL_COOLDOWN_MS (429 `cooldown`
 *                                 with `retryAfterSeconds`), except continuing a partial one.
 *                                 allowLargeClose (full mode, admin only) overrides the close
 *                                 guard (ADR 0017).
 *  GET  /api/sync/status          any signed-in role: per-division, per-entity sync state
 *
 * `:id` and `divisionId` are our divisions.id, never the raw Exact division number. A division
 * whose connection is disabled is not offered and cannot be selected or synced.
 */
import { auditStatement } from "../db/audit";
import { json, type Ctx, type Router } from "../router";
import { syncDivision, type SyncMode } from "./sync";

const ANY_ROLE = { roles: ["admin", "finance", "approver", "viewer"] } as const;
const SYNC_ROLES = { roles: ["admin", "finance"] } as const;

/** A manual sync stops between steps after this long and answers `partial`. */
export const MANUAL_SYNC_MAX_MS = 20_000;
/** Exact calls per manual slice (about one minute of the 60/min limit). */
export const MANUAL_SYNC_BUDGET = 60;
/** One new manual run per division per this long, unless it continues a partial one. */
export const MANUAL_COOLDOWN_MS = 60_000;

interface DivisionJoin {
  id: number;
  connection_id: number;
  exact_division: number;
  name: string;
  base_currency: string;
  connection_status: string;
}

const listDivisions = async (db: D1Database): Promise<DivisionJoin[]> =>
  (
    await db
      .prepare(
        `SELECT d.id, d.connection_id, d.exact_division, d.name, d.base_currency,
                c.status AS connection_status
         FROM divisions d JOIN connections c ON c.id = d.connection_id
         WHERE c.kind = 'exact' AND c.status <> 'disabled'
         ORDER BY d.name COLLATE NOCASE, d.id`,
      )
      .all<DivisionJoin>()
  ).results;

interface RunRow {
  division_id: number;
  mode: string | null;
  last_status: string | null;
  last_error: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_completed_at: string | null;
}

/**
 * Seconds until a manual run of `mode` may start (0 = now). Continuing a partial run of the same
 * mode is always allowed, except after a rate limit (then the cooldown applies); a run that is
 * still marked running is left to the lease (409).
 */
export function cooldownSeconds(run: RunRow | undefined, mode: SyncMode, nowMs: number): number {
  if (!run || run.last_started_at === null || run.last_status === "running") return 0;
  if (run.last_status === "partial" && run.mode === mode && run.last_error !== "rate_limited") {
    return 0;
  }
  const left = Date.parse(run.last_started_at) + MANUAL_COOLDOWN_MS - nowMs;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await request.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function positiveInt(v: unknown): number | null {
  if (typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v)) v = Number(v);
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** The user's stored selection if it is still valid, else the first division, else null. */
async function selectedId(
  db: D1Database,
  userId: number,
  divisions: readonly DivisionJoin[],
): Promise<number | null> {
  const pref = await db
    .prepare("SELECT division_id FROM user_prefs WHERE user_id = ?1")
    .bind(userId)
    .first<{ division_id: number | null }>();
  const saved = pref?.division_id ?? null;
  if (saved !== null && divisions.some((d) => d.id === saved)) return saved;
  return divisions[0]?.id ?? null;
}

export function registerSyncRoutes(router: Router): void {
  router.add("GET", "/api/divisions", ANY_ROLE, async (ctx) => {
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const db = ctx.env.DB;
    const divisions = await listDivisions(db);
    const runs = (
      await db
        .prepare(
          `SELECT division_id, mode, last_status, last_error, last_started_at, last_finished_at,
                  last_completed_at
           FROM sync_state WHERE entity = 'run'`,
        )
        .all<RunRow>()
    ).results;
    const nowIso = new Date(ctx.nowMs).toISOString();
    const locks = (
      await db
        .prepare("SELECT division_id FROM sync_locks WHERE expires_at > ?1")
        .bind(nowIso)
        .all<{ division_id: number }>()
    ).results;
    return json({
      selectedId: await selectedId(db, session.userId, divisions),
      divisions: divisions.map((d) => {
        const run = runs.find((r) => r.division_id === d.id);
        return {
          id: d.id,
          division: d.exact_division,
          name: d.name,
          currency: d.base_currency,
          connectionStatus: d.connection_status,
          syncing: locks.some((l) => l.division_id === d.id),
          lastSync:
            run && run.last_finished_at !== null
              ? {
                  status: run.last_status,
                  mode: run.mode,
                  error: run.last_error,
                  finishedAt: run.last_finished_at,
                  completedAt: run.last_completed_at,
                }
              : null,
          // Seconds a new manual run must wait, per mode (continuing a partial run is exempt).
          cooldown: {
            full: cooldownSeconds(run, "full", ctx.nowMs),
            incremental: cooldownSeconds(run, "incremental", ctx.nowMs),
          },
        };
      }),
    });
  });

  router.add("PUT", "/api/me/division", ANY_ROLE, async (ctx) => {
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const body = await readJson(ctx.request);
    const id = positiveInt(body?.["divisionId"]);
    if (id === null) return json({ error: "bad_request" }, 400);
    const db = ctx.env.DB;
    // Server-side check: only a division of an enabled Exact connection can be chosen.
    const known = (await listDivisions(db)).find((d) => d.id === id);
    if (!known) return json({ error: "unknown_division" }, 404);
    const nowIso = new Date(ctx.nowMs).toISOString();
    await db.batch([
      db
        .prepare(
          `INSERT INTO user_prefs (user_id, division_id, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (user_id) DO UPDATE SET division_id = excluded.division_id,
             updated_at = excluded.updated_at`,
        )
        .bind(session.userId, id, nowIso),
      auditStatement(db, {
        actorEmail: session.email,
        action: "user.division_selected",
        entity: "division",
        entityId: id,
        after: { divisionId: id },
      }),
    ]);
    return json({ selectedId: id });
  });

  router.add("POST", "/api/divisions/:id/sync", SYNC_ROLES, async (ctx: Ctx) => {
    const session = ctx.session;
    if (!session) return json({ error: "unauthenticated" }, 401);
    const id = positiveInt(ctx.params["id"]);
    if (id === null) return json({ error: "not_found" }, 404);
    const body = (await readJson(ctx.request)) ?? {};
    const rawMode = body["mode"] ?? "incremental";
    if (rawMode !== "full" && rawMode !== "incremental") return json({ error: "bad_request" }, 400);
    const mode: SyncMode = rawMode;
    const rawAllow = body["allowLargeClose"] ?? false;
    const rawRestart = body["restart"] ?? false;
    if (typeof rawAllow !== "boolean" || typeof rawRestart !== "boolean") {
      return json({ error: "bad_request" }, 400);
    }
    if (rawAllow && (mode !== "full" || !session.roles.includes("admin"))) {
      return json({ error: "forbidden" }, 403);
    }
    if (rawRestart && mode !== "full") return json({ error: "bad_request" }, 400);

    const division = (await listDivisions(ctx.env.DB)).find((d) => d.id === id);
    if (!division) return json({ error: "not_found" }, 404);
    if (division.connection_status !== "active") {
      return json(
        {
          error: division.connection_status === "needs_reauth" ? "needs_reauth" : "not_connected",
        },
        409,
      );
    }
    const run = (
      await ctx.env.DB.prepare(
        `SELECT division_id, mode, last_status, last_error, last_started_at, last_finished_at,
                last_completed_at
         FROM sync_state WHERE division_id = ?1 AND entity = 'run'`,
      )
        .bind(division.id)
        .all<RunRow>()
    ).results[0];
    const wait = cooldownSeconds(run, mode, ctx.nowMs);
    if (wait > 0) {
      return json({ error: "cooldown", retryAfterSeconds: wait }, 429, {
        "Retry-After": String(wait),
      });
    }
    const summary = await syncDivision(
      ctx.env,
      {
        id: division.id,
        connectionId: division.connection_id,
        exactDivision: division.exact_division,
        currency: division.base_currency,
      },
      {
        jobId: `sync:manual:${division.exact_division}:${ctx.nowMs}`,
        mode,
        budget: MANUAL_SYNC_BUDGET,
        actor: session.email,
        deadlineMs: Date.now() + MANUAL_SYNC_MAX_MS,
        allowLargeClose: rawAllow,
        restart: rawRestart,
        readIbans: false,
        guaranteeProgress: true,
      },
    );
    if (summary.status === "locked") return json({ error: "sync_running" }, 409);
    return json({
      status: summary.status,
      mode: summary.mode,
      callsUsed: summary.callsUsed,
      finishedAt: summary.finishedAt,
      cycleComplete: summary.cycleComplete,
      entities: Object.fromEntries(
        Object.entries(summary.entities).map(([name, r]) => [
          name,
          {
            status: r.status,
            rows: r.rows,
            calls: r.calls,
            ...(r.closed !== undefined ? { closed: r.closed } : {}),
            ...(r.progress !== undefined ? { progress: r.progress } : {}),
            ...(r.error !== undefined ? { error: r.error } : {}),
          },
        ]),
      ),
    });
  });

  router.add("GET", "/api/sync/status", ANY_ROLE, async (ctx) => {
    const db = ctx.env.DB;
    const divisions = await listDivisions(db);
    const states = (
      await db
        .prepare(
          `SELECT division_id, entity, mode, last_started_at, last_finished_at, last_completed_at,
                  last_status, last_error, rows_seen, calls_used, pass_rows, pass_total
           FROM sync_state ORDER BY division_id, entity`,
        )
        .all<{
          division_id: number;
          entity: string;
          mode: string | null;
          last_started_at: string | null;
          last_finished_at: string | null;
          last_completed_at: string | null;
          last_status: string | null;
          last_error: string | null;
          rows_seen: number;
          calls_used: number;
          pass_rows: number;
          pass_total: number | null;
        }>()
    ).results;
    const locks = (
      await db
        .prepare("SELECT division_id FROM sync_locks WHERE expires_at > ?1")
        .bind(new Date(ctx.nowMs).toISOString())
        .all<{ division_id: number }>()
    ).results;
    return json({
      divisions: divisions.map((d) => ({
        id: d.id,
        name: d.name,
        connectionStatus: d.connection_status,
        syncing: locks.some((l) => l.division_id === d.id),
        entities: states
          .filter((s) => s.division_id === d.id)
          .map((s) => ({
            entity: s.entity,
            mode: s.mode,
            status: s.last_status,
            error: s.last_error,
            startedAt: s.last_started_at,
            finishedAt: s.last_finished_at,
            completedAt: s.last_completed_at,
            rows: s.rows_seen,
            calls: s.calls_used,
            passRows: s.pass_rows,
            passTotal: s.pass_total,
          })),
      })),
    });
  });
}
