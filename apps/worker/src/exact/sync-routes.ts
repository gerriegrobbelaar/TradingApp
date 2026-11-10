/**
 * Administration (division) list and switcher, and manual sync.
 *
 *  GET  /api/divisions            any signed-in role: divisions, the user's selection, last sync
 *  PUT  /api/me/division          any signed-in role: remember the chosen division (validated)
 *  POST /api/divisions/:id/sync   admin or finance: run a sync now, inline (no step-up).
 *                                 Body `{ mode?: "full" | "incremental", allowEmptyClose?: true }`;
 *                                 allowEmptyClose (full mode, admin only) overrides the
 *                                 empty-list guard (ADR 0017).
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
export const MANUAL_SYNC_BUDGET = 300;

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
  last_finished_at: string | null;
  last_completed_at: string | null;
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
          `SELECT division_id, mode, last_status, last_error, last_finished_at, last_completed_at
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
    const rawAllow = body["allowEmptyClose"] ?? false;
    if (typeof rawAllow !== "boolean") return json({ error: "bad_request" }, 400);
    if (rawAllow && (mode !== "full" || !session.roles.includes("admin"))) {
      return json({ error: "forbidden" }, 403);
    }

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
        allowEmptyClose: rawAllow,
      },
    );
    if (summary.status === "locked") return json({ error: "sync_running" }, 409);
    return json({
      status: summary.status,
      mode: summary.mode,
      callsUsed: summary.callsUsed,
      finishedAt: summary.finishedAt,
      entities: Object.fromEntries(
        Object.entries(summary.entities).map(([name, r]) => [
          name,
          {
            status: r.status,
            rows: r.rows,
            calls: r.calls,
            ...(r.closed !== undefined ? { closed: r.closed } : {}),
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
                  last_status, last_error, rows_seen, calls_used
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
          })),
      })),
    });
  });
}
