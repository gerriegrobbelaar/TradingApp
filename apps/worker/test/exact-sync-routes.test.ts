import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireSyncLock, syncDivision } from "../src/exact/sync";
import { addSession, addUser, authed, call, resetDb } from "./helpers";
import { freshDivision, seedConnection, stubExact, type ExactStub } from "./exact-helpers";
import { FakeExact, auditRows, db, guid, resetSync } from "./sync-helpers";

const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";
const FINANCE = "fin@camelthorncapital.com";
const VIEWER = "v@camelthorncapital.com";
const APPROVER = "ap@camelthorncapital.com";

const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
let stub: ExactStub;
let connId: number;
let divA: { id: number; exact: number };
let divB: { id: number; exact: number };

async function addDiv(connection: number, name: string): Promise<{ id: number; exact: number }> {
  const exact = freshDivision();
  const r = await db
    .prepare("INSERT INTO divisions (connection_id, exact_division, name) VALUES (?1, ?2, ?3)")
    .bind(connection, exact, name)
    .run();
  return { id: r.meta.last_row_id, exact };
}

/** Routes the stubbed Exact HTTP API to a FakeExact (through the real client and gate). */
function serve(fx: FakeExact): void {
  stub.api = async (c) => {
    const path = c.url.pathname.replace(/^\/api\/v1\/(current|\d+)/, "");
    const query = Object.fromEntries(c.url.searchParams.entries());
    const res = await fx.transport({
      method: "GET",
      path,
      query,
      division: 0,
      priority: "job",
      jobId: "x",
      api: "rest",
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  };
}

beforeEach(async () => {
  await resetDb();
  await resetSync();
  for (const [key, email, roles] of [
    ["admin", ADMIN, ["admin"]],
    ["finance", FINANCE, ["finance"]],
    ["viewer", VIEWER, ["viewer"]],
    ["approver", APPROVER, ["approver"]],
  ] as const) {
    ids[key] = await addUser(email, [...roles]);
    tokens[key] = await addSession(ids[key] as number);
  }
  stub = stubExact();
  connId = await seedConnection();
  divA = await addDiv(connId, "Alpha BV");
  divB = await addDiv(connId, "Beta BV");
});
afterEach(() => stub.restore());

interface DivisionsBody {
  selectedId: number | null;
  divisions: {
    id: number;
    name: string;
    syncing: boolean;
    connectionStatus: string;
    lastSync: { status: string; finishedAt: string } | null;
  }[];
}

describe("GET /api/divisions", () => {
  it("is open to every signed-in role and closed to anonymous callers", async () => {
    for (const k of ["admin", "finance", "viewer", "approver"]) {
      const res = await authed("/api/divisions", tokens[k] as string);
      expect(res.status, k).toBe(200);
    }
    expect((await call("/api/divisions")).status).toBe(401);
    expect((await call("/api/sync/status")).status).toBe(401);
  });

  it("lists divisions with no sync yet, selecting the first when nothing is stored", async () => {
    const body = (await (
      await authed("/api/divisions", tokens["viewer"] as string)
    ).json()) as DivisionsBody;
    expect(body.divisions.map((d) => d.name)).toEqual(["Alpha BV", "Beta BV"]);
    expect(body.divisions[0]).toMatchObject({
      lastSync: null,
      syncing: false,
      connectionStatus: "active",
    });
    expect(body.selectedId).toBe(divA.id);
  });

  it("returns an empty list and no selection with no divisions", async () => {
    await resetSync();
    const body = (await (
      await authed("/api/divisions", tokens["viewer"] as string)
    ).json()) as DivisionsBody;
    expect(body).toEqual({ selectedId: null, divisions: [] });
  });

  it("hides divisions of a disabled connection", async () => {
    await db.prepare("UPDATE connections SET status = 'disabled' WHERE id = ?1").bind(connId).run();
    const body = (await (
      await authed("/api/divisions", tokens["viewer"] as string)
    ).json()) as DivisionsBody;
    expect(body.divisions).toEqual([]);
  });
});

describe("PUT /api/me/division", () => {
  const put = (token: string, json: unknown) =>
    authed("/api/me/division", token, { method: "PUT", json });

  it("persists the choice per user and audits it", async () => {
    expect((await put(tokens["viewer"] as string, { divisionId: divB.id })).status).toBe(200);
    const mine = (await (
      await authed("/api/divisions", tokens["viewer"] as string)
    ).json()) as DivisionsBody;
    expect(mine.selectedId).toBe(divB.id);
    // another user is unaffected
    const other = (await (
      await authed("/api/divisions", tokens["admin"] as string)
    ).json()) as DivisionsBody;
    expect(other.selectedId).toBe(divA.id);
    // changing it again updates the single row
    await put(tokens["viewer"] as string, { divisionId: divA.id });
    const again = (await (
      await authed("/api/divisions", tokens["viewer"] as string)
    ).json()) as DivisionsBody;
    expect(again.selectedId).toBe(divA.id);
    const rows = await db
      .prepare("SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?1")
      .bind(ids["viewer"])
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect((await auditRows("user.division_selected", divB.id)).at(-1)?.actor_email).toBe(VIEWER);
  });

  it("rejects an unknown or foreign division and malformed bodies, storing nothing", async () => {
    const token = tokens["viewer"] as string;
    expect((await put(token, { divisionId: 999999 })).status).toBe(404);
    // a division whose connection is disabled is not selectable
    const other = await db
      .prepare("INSERT INTO connections (kind, name, status) VALUES ('exact', 'old', 'disabled')")
      .run();
    const hidden = await addDiv(other.meta.last_row_id, "Hidden");
    expect((await put(token, { divisionId: hidden.id })).status).toBe(404);
    // the raw Exact division number is not an id
    expect((await put(token, { divisionId: divA.exact })).status).toBe(404);
    for (const bad of [
      {},
      { divisionId: "abc" },
      { divisionId: -1 },
      { divisionId: 1.5 },
      { divisionId: null },
      [],
    ]) {
      expect((await put(token, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?1")
      .bind(ids["viewer"])
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("needs a session and the CSRF header", async () => {
    expect(
      (
        await call("/api/me/division", {
          method: "PUT",
          headers: { "content-type": "application/json", "x-requested-with": "fetch" },
          body: JSON.stringify({ divisionId: divA.id }),
        })
      ).status,
    ).toBe(401);
    const noCsrf = await call("/api/me/division", {
      method: "PUT",
      headers: { cookie: `__Host-session=${tokens["viewer"]}`, "content-type": "application/json" },
      body: JSON.stringify({ divisionId: divA.id }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it("falls back to the first division when the stored one is no longer offered", async () => {
    await put(tokens["viewer"] as string, { divisionId: divB.id });
    await db.prepare("UPDATE connections SET status = 'disabled' WHERE id = ?1").bind(connId).run();
    const fresh = await db
      .prepare("INSERT INTO connections (kind, name, status) VALUES ('exact', 'second', 'active')")
      .run();
    const c = await addDiv(fresh.meta.last_row_id, "Gamma BV");
    const body = (await (
      await authed("/api/divisions", tokens["viewer"] as string)
    ).json()) as DivisionsBody;
    expect(body.selectedId).toBe(c.id);
  });
});

describe("POST /api/divisions/:id/sync", () => {
  const post = (token: string, id: number | string, json?: unknown) =>
    authed(`/api/divisions/${id}/sync`, token, {
      method: "POST",
      ...(json !== undefined ? { json } : {}),
    });

  it("is limited to admin and finance, and needs a session and CSRF header", async () => {
    expect((await post(tokens["viewer"] as string, divA.id, { mode: "incremental" })).status).toBe(
      403,
    );
    expect((await post(tokens["approver"] as string, divA.id)).status).toBe(403);
    expect(
      (
        await call(`/api/divisions/${divA.id}/sync`, {
          method: "POST",
          headers: { "x-requested-with": "f" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(`/api/divisions/${divA.id}/sync`, {
          method: "POST",
          headers: { cookie: `__Host-session=${tokens["finance"]}` },
        })
      ).status,
    ).toBe(403);
    expect(await auditRows("exact.sync", divA.id)).toHaveLength(0);
  });

  it("validates the id and the mode", async () => {
    const t = tokens["finance"] as string;
    expect((await post(t, 99999)).status).toBe(404);
    expect((await post(t, "abc")).status).toBe(404);
    expect((await post(t, divA.id, { mode: "nightly" })).status).toBe(400);
    expect(stub.apiCalls).toHaveLength(0);
  });

  it("lets only an admin override the close guard, and only in full mode", async () => {
    const fin = tokens["finance"] as string;
    const adm = tokens["admin"] as string;
    expect((await post(fin, divA.id, { mode: "full", allowLargeClose: true })).status).toBe(403);
    expect((await post(adm, divA.id, { mode: "incremental", allowLargeClose: true })).status).toBe(
      403,
    );
    expect((await post(adm, divA.id, { mode: "full", allowLargeClose: "yes" })).status).toBe(400);
    expect(stub.apiCalls).toHaveLength(0);
    expect(await auditRows("exact.sync", divA.id)).toHaveLength(0);
  });

  it("runs a sync through the real client and gate for finance, and audits the actor", async () => {
    const fx = new FakeExact(divA.exact);
    fx.divisions = [{ code: divA.exact, description: "Alpha Advisory B.V." }];
    fx.accounts = [{ n: 1, name: "Acme", ts: 5, customer: true }];
    fx.receivables = [
      { n: 11, account: 1, name: "Acme", amount: 100.5, currency: "EUR", invoiceNumber: 1, ts: 9 },
    ];
    fx.pageSize = 50;
    serve(fx);
    const res = await post(tokens["finance"] as string, divA.id, { mode: "full" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      mode: string;
      entities: Record<string, { status: string; rows: number }>;
    };
    expect(body).toMatchObject({ status: "ok", mode: "full" });
    expect(body.entities["receivables"]).toMatchObject({ status: "ok", rows: 1 });
    // every call carried the stored bearer token through the gate
    expect(stub.apiCalls.length).toBeGreaterThan(3);
    expect(stub.apiCalls.every((c) => c.headers["authorization"] === "Bearer acc-0")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("acc-0");

    const item = await db
      .prepare("SELECT open_minor FROM open_items WHERE division_id = ?1 AND exact_id = ?2")
      .bind(divA.id, guid(11))
      .first<{ open_minor: number }>();
    expect(item?.open_minor).toBe(10050);
    const audit = await auditRows("exact.sync", divA.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_email).toBe(FINANCE);

    const list = (await (
      await authed("/api/divisions", tokens["viewer"] as string)
    ).json()) as DivisionsBody;
    const a = list.divisions.find((d) => d.id === divA.id);
    expect(a?.name).toBe("Alpha Advisory B.V.");
    expect(a?.lastSync).toMatchObject({ status: "ok" });
    const status = (await (
      await authed("/api/sync/status", tokens["viewer"] as string)
    ).json()) as {
      divisions: { id: number; entities: { entity: string; status: string }[] }[];
    };
    const s = status.divisions.find((d) => d.id === divA.id);
    expect(s?.entities.map((e) => e.entity)).toContain("receivables");
  });

  it("answers partial when the job budget runs out, and keeps going on the next call", async () => {
    const fx = new FakeExact(divA.exact);
    fx.divisions = [{ code: divA.exact, description: "Alpha" }];
    fx.pageSize = 1;
    fx.accounts = [1, 2, 3, 4].map((m) => ({ n: m, name: `R${m}`, ts: m * 10 }));
    serve(fx);
    // Drive the sync directly with a tiny budget through the real gate (the route's budget is fixed).
    const summary = await syncDivision(
      env,
      { id: divA.id, connectionId: connId, exactDivision: divA.exact },
      { jobId: `tiny-${Date.now()}`, mode: "full", budget: 5, chunkPages: 1, actor: ADMIN },
    );
    expect(summary.status).toBe("partial");
    expect(summary.entities.relations.error).toBe("budget_exhausted");
    expect(stub.apiCalls.length).toBeLessThanOrEqual(5);
    const cursor = await db
      .prepare("SELECT cursor FROM sync_state WHERE division_id = ?1 AND entity = 'relations'")
      .bind(divA.id)
      .first<{ cursor: string }>();
    expect(cursor?.cursor).toBe("20");
  });

  it("answers 409 when the connection needs re-authorisation or a sync is running", async () => {
    const t = tokens["admin"] as string;
    expect(await acquireSyncLock(db, divB.id, "other", Date.now())).toBe(1);
    const busy = await post(t, divB.id);
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe("sync_running");
    const syncing = (await (await authed("/api/divisions", t)).json()) as DivisionsBody;
    expect(syncing.divisions.find((d) => d.id === divB.id)?.syncing).toBe(true);

    await db
      .prepare("UPDATE connections SET status = 'needs_reauth' WHERE id = ?1")
      .bind(connId)
      .run();
    const reauth = await post(t, divA.id);
    expect(reauth.status).toBe(409);
    expect(((await reauth.json()) as { error: string }).error).toBe("needs_reauth");
    expect(stub.apiCalls).toHaveLength(0);
  });
});

describe("manual slices (review G1)", () => {
  const post = (token: string, json: unknown) =>
    authed(`/api/divisions/${divA.id}/sync`, token, { method: "POST", json });
  type Body = {
    status: string;
    cycleComplete: boolean;
    entities: Record<
      string,
      { status: string; rows: number; progress?: { read: number; total: number | null } }
    >;
  };

  it("answers partial with progress, continues without a cooldown, then asks to wait", async () => {
    const fin = tokens["finance"] as string;
    const fx = new FakeExact(divA.exact);
    fx.divisions = [{ code: divA.exact, description: "Alpha" }];
    fx.pageSize = 1; // one row per call
    fx.receivables = Array.from({ length: 30 }, (_, i) => ({
      n: 100 + i,
      account: 1,
      name: "Acme",
      amount: 10,
      currency: "EUR",
      invoiceNumber: i,
      ts: 10 + i,
    }));
    serve(fx);
    // A clock that moves 2 s per reading: the 20 s slice deadline passes after a few pages.
    let t = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (t += 2000));
    try {
      let read = 0;
      let slices = 0;
      let last: Body | null = null;
      while (slices < 40) {
        slices++;
        const res = await post(fin, { mode: "full" }); // continuing a partial run: no cooldown
        expect(res.status).toBe(200);
        last = (await res.json()) as Body;
        const progress = last.entities["receivables"]?.progress;
        if (last.status === "ok") break;
        expect(last.status).toBe("partial");
        expect(last.cycleComplete).toBe(false);
        if (progress !== undefined) {
          expect(progress.read).toBeGreaterThan(read); // every slice advances
          read = progress.read;
        }
      }
      expect(slices).toBeGreaterThan(1);
      expect(last?.status).toBe("ok");
      expect(last?.cycleComplete).toBe(true);
      expect(read).toBe(30);
      // Manual full runs leave the IBANs to the nightly run.
      expect(stub.apiCalls.some((c) => c.url.pathname.endsWith("/crm/BankAccounts"))).toBe(false);

      // A new run right after: 429 with a retry hint, nothing sent to Exact.
      const calls = stub.apiCalls.length;
      for (const mode of ["full", "incremental"]) {
        const wait = await post(fin, { mode });
        expect(wait.status).toBe(429);
        const body = (await wait.json()) as { error: string; retryAfterSeconds: number };
        expect(body.error).toBe("cooldown");
        expect(body.retryAfterSeconds).toBeGreaterThan(0);
        expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
        expect(wait.headers.get("Retry-After")).toBe(String(body.retryAfterSeconds));
      }
      expect(stub.apiCalls.length).toBe(calls);
      const list = (await (await authed("/api/divisions", tokens["viewer"] as string)).json()) as {
        divisions: { id: number; cooldown: { full: number; incremental: number } }[];
      };
      expect(list.divisions.find((d) => d.id === divA.id)?.cooldown.full).toBeGreaterThan(0);

      // After the cooldown a new run is allowed again.
      t += 61_000;
      expect((await post(fin, { mode: "incremental" })).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it("validates restart (full mode only)", async () => {
    const fin = tokens["finance"] as string;
    expect((await post(fin, { mode: "incremental", restart: true })).status).toBe(400);
    expect((await post(fin, { mode: "full", restart: "yes" })).status).toBe(400);
    expect(stub.apiCalls).toHaveLength(0);
  });
});
