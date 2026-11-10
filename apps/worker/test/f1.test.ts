import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { auditStatement, LAST_INSERT_ID } from "../src/db/audit";
import { seedInitialAdmin } from "../src/db/seed";
import { Router, json } from "../src/router";
import {
  ORIGIN,
  addSession,
  addUser,
  authed,
  claims,
  db,
  doLogin,
  makeKey,
  newStub,
  resetDb,
  signJwt,
  stubGoogle,
  type TestKey,
} from "./helpers";

const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";
let adminId: number;
let adminTok: string;

/** audit_log is append-only and never reset, so each test counts only rows after this id. */
let auditBaseline = 0;

beforeEach(async () => {
  await resetDb();
  adminId = await addUser(ADMIN, ["admin"]);
  adminTok = await addSession(adminId);
  auditBaseline =
    (await db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM audit_log").first<{ m: number }>())
      ?.m ?? 0;
});
afterEach(() => vi.restoreAllMocks());

const n = async (sql: string, ...b: unknown[]): Promise<number> =>
  (
    await db
      .prepare(sql)
      .bind(...b)
      .first<{ n: number }>()
  )?.n ?? -1;
const auditCount = (action: string): Promise<number> =>
  n("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1 AND id > ?2", action, auditBaseline);
const patch = (id: number, tok: string, roles: string[]) =>
  authed(`/api/users/${id}/roles`, tok, { method: "PATCH", json: { roles } });

describe("auditStatement", () => {
  it("masks and redacts exactly like writeAudit, and honours its guard", async () => {
    const before = await auditCount("t.mask");
    await db.batch([
      auditStatement(db, {
        actorEmail: " A@B.com ",
        action: "t.mask",
        entity: "x",
        entityId: "NL91 ABNA 0417 1643 00",
        after: { iban: "NL91ABNA0417164300", token: "abc", note: "pay NL91ABNA0417164300" },
      }),
      auditStatement(
        db,
        { actorEmail: "a@b.com", action: "t.mask", entity: "x" },
        { sql: "?7 = 2", binds: [1] },
      ),
    ]);
    expect(await auditCount("t.mask")).toBe(before + 1);
    const row = await db
      .prepare(
        "SELECT actor_email, entity_id, after_json FROM audit_log WHERE action = 't.mask' ORDER BY id DESC LIMIT 1",
      )
      .first<{ actor_email: string; entity_id: string; after_json: string }>();
    expect(row?.actor_email).toBe("a@b.com");
    expect(row?.entity_id).not.toContain("1643");
    expect(row?.after_json).not.toContain("0417164300");
    expect(row?.after_json).toContain("[redacted]");
  });

  it("LAST_INSERT_ID records the row id of the insert before it", async () => {
    const res = await db.batch([
      db.prepare("INSERT INTO invites (email, roles, invited_by) VALUES ('li@x.com','[]','a')"),
      auditStatement(db, {
        actorEmail: "a@b.com",
        action: "t.last",
        entity: "invite",
        entityId: LAST_INSERT_ID,
      }),
    ]);
    const row = await db
      .prepare("SELECT entity_id FROM audit_log WHERE action = 't.last'")
      .first<{ entity_id: string }>();
    expect(row?.entity_id).toBe(String(res[0]?.meta.last_row_id));
  });
});

describe("atomic change + audit", () => {
  it("two concurrent PATCHes adding the same role both succeed with one role row", async () => {
    const uid = await addUser("f@camelthorncapital.com", ["viewer"]);
    const rs = await Promise.all([
      patch(uid, adminTok, ["viewer", "finance"]),
      patch(uid, adminTok, ["viewer", "finance"]),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await n("SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ?1 AND role = 'finance'", uid),
    ).toBe(1);
    // The later one may see the role already present and then writes nothing (no-op).
    const audits = await auditCount("user.roles_changed");
    expect(audits === 1 || audits === 2).toBe(true);
  });

  it("a PATCH that changes nothing writes no audit row and keeps sessions", async () => {
    const uid = await addUser("f@camelthorncapital.com", ["viewer", "finance"]);
    await addSession(uid);
    const res = await patch(uid, adminTok, ["finance", "viewer"]);
    expect(res.status).toBe(200);
    expect(await auditCount("user.roles_changed")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1", uid)).toBe(1);
  });

  it("a failing batch leaves neither the change nor the audit row", async () => {
    const uid = await addUser("f@camelthorncapital.com", ["finance", "approver"]);
    const real = env.DB;
    const broken = {
      prepare: (q: string) => real.prepare(q),
      batch: (stmts: D1PreparedStatement[]) =>
        real.batch([...stmts, real.prepare("SELECT * FROM table_that_does_not_exist")]),
    } as unknown as D1Database;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/users/${uid}/roles`, {
        method: "PATCH",
        headers: {
          cookie: `__Host-session=${adminTok}`,
          "x-requested-with": "fetch",
          "content-type": "application/json",
        },
        body: JSON.stringify({ roles: ["viewer"] }),
      }),
      { ...env, DB: broken },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    const { results } = await db
      .prepare("SELECT role FROM user_roles WHERE user_id = ?1 ORDER BY role")
      .bind(uid)
      .all<{ role: string }>();
    expect(results.map((r) => r.role)).toEqual(["approver", "finance"]);
    expect(await auditCount("user.roles_changed")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1", adminId)).toBe(1);
  });

  it("a blocked last-admin change writes no audit row and keeps sessions", async () => {
    const res = await patch(adminId, adminTok, ["viewer"]);
    expect(res.status).toBe(409);
    expect(await auditCount("user.roles_changed")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1", adminId)).toBe(1);
    const del = await authed(`/api/users/${adminId}`, adminTok, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect(await auditCount("user.disabled")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1", adminId)).toBe(1);
  });

  it("two admins demoting each other concurrently: exactly one winner", async () => {
    const second = await addUser("b@camelthorncapital.com", ["admin"]);
    const secondTok = await addSession(second);
    const rs = await Promise.all([
      patch(second, adminTok, ["viewer"]),
      patch(adminId, secondTok, ["viewer"]),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await n(
        `SELECT COUNT(*) AS n FROM user_roles r JOIN users u ON u.id = r.user_id
         WHERE r.role = 'admin' AND u.disabled_at IS NULL`,
      ),
    ).toBe(1);
    expect(await auditCount("user.roles_changed")).toBe(1);
  });

  it("invite writes the invite and its audit row with the invite id", async () => {
    const res = await authed("/api/users/invite", adminTok, {
      method: "POST",
      json: { email: "new@camelthorncapital.com", roles: ["viewer"] },
    });
    const { id } = (await res.json()) as { id: number };
    const row = await db
      .prepare("SELECT entity, entity_id FROM audit_log WHERE action = 'user.invite'")
      .first();
    expect(row).toEqual({ entity: "invite", entity_id: String(id) });
  });

  it("accepting an invite audits atomically (accept + user + roles + audit)", async () => {
    const key: TestKey = await makeKey("k-f1");
    await db
      .prepare("INSERT INTO invites (email, roles, invited_by) VALUES (?1, '[\"viewer\"]', ?2)")
      .bind("new@camelthorncapital.com", ADMIN)
      .run();
    const stub = newStub([key], (nonce, k) =>
      signJwt(k, claims({ nonce, email: "new@camelthorncapital.com", sub: "sub-new" })),
    );
    stubGoogle(stub);
    const r = await doLogin(stub);
    expect(r.sessionToken).toBeTruthy();
    expect(await auditCount("invite.accept")).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM invites WHERE accepted_at IS NOT NULL")).toBe(1);
  });
});

describe("router error handling and headers", () => {
  it("returns 500 internal_error and logs only the error name and route pattern", async () => {
    const router = new Router().add("POST", "/api/boom/:id", { public: true }, () => {
      throw new TypeError("secret NL91ABNA0417164300 token=abc");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await router.handle(
      new Request(`${ORIGIN}/api/boom/42?x=secret`, {
        method: "POST",
        headers: { "x-requested-with": "fetch" },
        body: "secret-body",
      }),
      env,
    );
    expect(res?.status).toBe(500);
    expect(await res?.json()).toEqual({ error: "internal_error" });
    expect(spy).toHaveBeenCalledWith("unhandled error", "TypeError", "POST /api/boom/:id");
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret|NL91|token|42/);
  });

  it("json() sets no-store and nosniff, and keeps caller headers", async () => {
    const res = json({ a: 1 }, 201, { "x-extra": "1" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-extra")).toBe("1");
    expect(res.status).toBe(201);
    const health = await worker.fetch(new Request(`${ORIGIN}/api/health`), env);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("revoke invite and restore user", () => {
  const post = (path: string, tok: string, body?: unknown) =>
    authed(path, tok, { method: "POST", ...(body !== undefined ? { json: body } : {}) });
  const invite = async (email: string): Promise<number> =>
    (
      await db
        .prepare("INSERT INTO invites (email, roles, invited_by) VALUES (?1, '[\"viewer\"]', ?2)")
        .bind(email, ADMIN)
        .run()
    ).meta.last_row_id;

  it("revokes a pending invite, audits it, and frees the email", async () => {
    const id = await invite("p@camelthorncapital.com");
    const res = await authed(`/api/users/invites/${id}`, adminTok, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(
      await n("SELECT COUNT(*) AS n FROM invites WHERE id = ?1 AND revoked_at IS NOT NULL", id),
    ).toBe(1);
    expect(await auditCount("user.invite_revoked")).toBe(1);
    const again = await authed(`/api/users/invites/${id}`, adminTok, { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(await auditCount("user.invite_revoked")).toBe(1);
    const reinvite = await post("/api/users/invite", adminTok, {
      email: "p@camelthorncapital.com",
      roles: ["viewer"],
    });
    expect(reinvite.status).toBe(201);
  });

  it("revoke needs admin and step-up, and validates the id", async () => {
    const id = await invite("p@camelthorncapital.com");
    const stale = await addSession(adminId, { lastAuthAgoMs: 3600_000 });
    expect((await authed(`/api/users/invites/${id}`, stale, { method: "DELETE" })).status).toBe(
      401,
    );
    const fin = await addUser("f@camelthorncapital.com", ["finance"]);
    const finTok = await addSession(fin);
    expect((await authed(`/api/users/invites/${id}`, finTok, { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await authed("/api/users/invites/abc", adminTok, { method: "DELETE" })).status).toBe(
      400,
    );
    expect(await n("SELECT COUNT(*) AS n FROM invites WHERE revoked_at IS NULL")).toBe(1);
  });

  it("inviting a removed user answers 409 user_disabled", async () => {
    await addUser("gone@camelthorncapital.com", ["viewer"], { disabled: true });
    const res = await post("/api/users/invite", adminTok, {
      email: "gone@camelthorncapital.com",
      roles: ["viewer"],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "user_disabled" });
  });

  it("restores a removed user with exactly the given roles and drops old sessions", async () => {
    const uid = await addUser("gone@camelthorncapital.com", ["admin", "finance"], {
      disabled: true,
    });
    await db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, last_auth_at) VALUES (?1, ?2, 'a', 'a', 'a', 'a')",
      )
      .bind("a".repeat(64), uid)
      .run();
    const res = await post(`/api/users/${uid}/restore`, adminTok, { roles: ["viewer", "viewer"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: uid, roles: ["viewer"] });
    expect(
      await n("SELECT COUNT(*) AS n FROM users WHERE id = ?1 AND disabled_at IS NULL", uid),
    ).toBe(1);
    const { results } = await db
      .prepare("SELECT role FROM user_roles WHERE user_id = ?1")
      .bind(uid)
      .all<{ role: string }>();
    expect(results.map((r) => r.role)).toEqual(["viewer"]);
    expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1", uid)).toBe(0);
    const a = await db
      .prepare(
        "SELECT actor_email, before_json, after_json FROM audit_log WHERE action = 'user.restored'",
      )
      .first<{ actor_email: string; before_json: string; after_json: string }>();
    expect(a?.actor_email).toBe(ADMIN);
    expect(JSON.parse(a?.before_json ?? "").roles).toEqual(["admin", "finance"]);
    expect(JSON.parse(a?.after_json ?? "")).toEqual({ roles: ["viewer"] });
  });

  it("restore validates roles, id, state, and needs admin plus step-up", async () => {
    const uid = await addUser("gone@camelthorncapital.com", ["viewer"], { disabled: true });
    expect((await post(`/api/users/${uid}/restore`, adminTok, { roles: [] })).status).toBe(400);
    expect((await post(`/api/users/${uid}/restore`, adminTok, { roles: ["x"] })).status).toBe(400);
    expect((await post(`/api/users/${uid}/restore`, adminTok)).status).toBe(400);
    expect((await post("/api/users/abc/restore", adminTok, { roles: ["viewer"] })).status).toBe(
      400,
    );
    expect((await post("/api/users/9999/restore", adminTok, { roles: ["viewer"] })).status).toBe(
      404,
    );
    expect(
      (await post(`/api/users/${adminId}/restore`, adminTok, { roles: ["viewer"] })).status,
    ).toBe(409);
    const stale = await addSession(adminId, { lastAuthAgoMs: 3600_000 });
    expect((await post(`/api/users/${uid}/restore`, stale, { roles: ["viewer"] })).status).toBe(
      401,
    );
    const fin = await addUser("f@camelthorncapital.com", ["finance"]);
    expect(
      (await post(`/api/users/${uid}/restore`, await addSession(fin), { roles: ["viewer"] }))
        .status,
    ).toBe(403);
    expect(
      await n("SELECT COUNT(*) AS n FROM users WHERE id = ?1 AND disabled_at IS NOT NULL", uid),
    ).toBe(1);
    expect(await auditCount("user.restored")).toBe(0);
  });

  it("two concurrent restores: one 200, one 409, one audit row", async () => {
    const uid = await addUser("gone@camelthorncapital.com", ["viewer"], { disabled: true });
    const rs = await Promise.all([
      post(`/api/users/${uid}/restore`, adminTok, { roles: ["finance"] }),
      post(`/api/users/${uid}/restore`, adminTok, { roles: ["finance"] }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await auditCount("user.restored")).toBe(1);
  });
});

describe("retention", () => {
  let key: TestKey;
  beforeAll(async () => {
    key = await makeKey("k-ret");
  });

  it("sign-in purges old auth.flow keys only, bounded, and other scopes survive", async () => {
    await db.prepare("DELETE FROM idempotency_keys").run();
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const ins = (scope: string, k: string, at: string) =>
      db
        .prepare("INSERT INTO idempotency_keys (scope, key, created_at) VALUES (?1, ?2, ?3)")
        .bind(scope, k, at);
    await db.batch([
      ins("revolut.pay", "old-pay", old),
      ins("auth.flow", "fresh-flow", fresh),
      ...Array.from({ length: 130 }, (_, i) => ins("auth.flow", `old-${i}`, old)),
    ]);
    await addUser("s@camelthorncapital.com", ["viewer"], { sub: null });
    const stub = newStub([key], (nonce, k) =>
      signJwt(k, claims({ nonce, email: "s@camelthorncapital.com", sub: "sub-s" })),
    );
    stubGoogle(stub);
    expect((await doLogin(stub)).sessionToken).toBeTruthy();
    expect(await n("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope = 'revolut.pay'")).toBe(
      1,
    );
    expect(await n("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = 'fresh-flow'")).toBe(1);
    // 130 old purged at most 100 at a time; the new claim itself is fresh.
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope = 'auth.flow' AND key LIKE 'old-%'",
      ),
    ).toBe(30);
  });

  it("creating a session purges expired sessions, bounded", async () => {
    const past = "2020-01-01T00:00:00.000Z";
    await db.batch(
      Array.from({ length: 120 }, (_, i) =>
        db
          .prepare(
            "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, last_auth_at) VALUES (?1, ?2, ?3, ?3, ?3, ?3)",
          )
          .bind(String(i).padStart(64, "0"), adminId, past),
      ),
    );
    await addSession(adminId);
    // adminTok (live) + the new one + 20 of the dead ones left over from the 100-row bound.
    expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE expires_at = ?1", past)).toBe(20);
    expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?1", past)).toBe(2);
  });
});

describe("seed marker short-circuit", () => {
  it("does not open a write batch once the marker exists", async () => {
    await seedInitialAdmin(db, "seed@camelthorncapital.com");
    let batches = 0;
    const counting = {
      prepare: (q: string) => db.prepare(q),
      batch: (s: D1PreparedStatement[]) => {
        batches++;
        return db.batch(s);
      },
    } as unknown as D1Database;
    expect(await seedInitialAdmin(counting, "seed@camelthorncapital.com")).toBe("exists");
    expect(batches).toBe(0);
  });
});

describe("F1 review: sign-in, logout and headers", () => {
  let key: TestKey;
  beforeAll(async () => {
    key = await makeKey("k-f1r");
  });
  const loginAs = (email: string, sub: string, stepUp = false) => {
    const stub = newStub([key], (nonce, k) =>
      signJwt(k, claims({ nonce, email, sub, auth_time: Math.floor(Date.now() / 1000) })),
    );
    stubGoogle(stub);
    return doLogin(stub, { stepUp });
  };

  it("an invite revoked through the API cannot be used to sign in", async () => {
    const res = await authed("/api/users/invite", adminTok, {
      method: "POST",
      json: { email: "rv@camelthorncapital.com", roles: ["finance"] },
    });
    const { id } = (await res.json()) as { id: number };
    expect((await authed(`/api/users/invites/${id}`, adminTok, { method: "DELETE" })).status).toBe(
      200,
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await loginAs("rv@camelthorncapital.com", "sub-rv");
    expect(r.sessionToken).toBeUndefined();
    expect(r.callback.headers.get("location")).toBe("/?auth=denied");
    expect(
      await n("SELECT COUNT(*) AS n FROM users WHERE email = 'rv@camelthorncapital.com'"),
    ).toBe(0);
    expect(await auditCount("invite.accept")).toBe(0);
  });

  it("a restored user can sign in again with the same Google account", async () => {
    const uid = await addUser("back@camelthorncapital.com", ["viewer"], {
      sub: "sub-back",
      disabled: true,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await loginAs("back@camelthorncapital.com", "sub-back")).sessionToken).toBeUndefined();
    const restored = await authed(`/api/users/${uid}/restore`, adminTok, {
      method: "POST",
      json: { roles: ["finance"] },
    });
    expect(restored.status).toBe(200);
    expect((await loginAs("back@camelthorncapital.com", "sub-back")).sessionToken).toBeTruthy();
  });

  it("concurrent invites each audit their own invite id (last_insert_rowid in a batch)", async () => {
    const emails = Array.from({ length: 6 }, (_, i) => `c${i}@camelthorncapital.com`);
    const rs = await Promise.all(
      emails.map((email) =>
        authed("/api/users/invite", adminTok, {
          method: "POST",
          json: { email, roles: ["viewer"] },
        }),
      ),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const { results } = await db
      .prepare(
        `SELECT a.entity_id, json_extract(a.after_json, '$.email') AS email, i.id AS invite_id
         FROM audit_log a JOIN invites i ON i.email = json_extract(a.after_json, '$.email')
         WHERE a.action = 'user.invite' AND a.id > ?1`,
      )
      .bind(auditBaseline)
      .all<{ entity_id: string; email: string; invite_id: number }>();
    expect(results).toHaveLength(emails.length);
    for (const r of results) expect(r.entity_id).toBe(String(r.invite_id));
  });

  it("sign-in commits the session and its auth.login audit row together", async () => {
    await addUser("s1@camelthorncapital.com", ["viewer"], { sub: "sub-s1" });
    // The auth.login audit insert fails (wherever it runs): the session must not survive it,
    // which only holds when session and audit row commit in one batch.
    const real = env.DB;
    const sqlOf = new WeakMap<D1PreparedStatement, string>();
    const isAudit = (s: D1PreparedStatement): boolean =>
      sqlOf.get(s)?.includes("INSERT INTO audit_log") ?? false;
    const wrap = (st: D1PreparedStatement, q: string): D1PreparedStatement => {
      sqlOf.set(st, q);
      const bind = st.bind.bind(st);
      const run = st.run.bind(st);
      st.bind = (...v: unknown[]) => wrap(bind(...v), q);
      st.run = (() =>
        q.includes("INSERT INTO audit_log")
          ? Promise.reject(new Error("audit write failed"))
          : run()) as D1PreparedStatement["run"];
      return st;
    };
    const broken = {
      prepare: (q: string) => wrap(real.prepare(q), q),
      batch: (stmts: D1PreparedStatement[]) =>
        stmts.some(isAudit)
          ? real.batch([...stmts, real.prepare("SELECT * FROM table_that_does_not_exist")])
          : real.batch(stmts),
    } as unknown as D1Database;
    const stub = newStub([key], (nonce, k) =>
      signJwt(k, claims({ nonce, email: "s1@camelthorncapital.com", sub: "sub-s1" })),
    );
    stubGoogle(stub);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const login = await worker.fetch(new Request(`${ORIGIN}/api/auth/login`), env);
    const authUrl = new URL(login.headers.get("location") ?? "");
    const flow = (login.headers as Headers & { getSetCookie(): string[] })
      .getSetCookie()
      .find((c) => c.startsWith("__Host-oauth="))
      ?.split(";")[0];
    // The helper's token stub reads the nonce from the last doLogin; drive one real login first.
    const ok = await loginAs("s1@camelthorncapital.com", "sub-s1");
    expect(ok.sessionToken).toBeTruthy();
    const before = await auditCount("auth.login");
    const sessionsBefore = await n("SELECT COUNT(*) AS n FROM sessions");
    const stub2 = newStub([key], (_nonce, k) =>
      signJwt(
        k,
        claims({
          nonce: authUrl.searchParams.get("nonce"),
          email: "s1@camelthorncapital.com",
          sub: "sub-s1",
        }),
      ),
    );
    stubGoogle(stub2);
    const cb = await worker.fetch(
      new Request(
        `${ORIGIN}/api/auth/callback?code=x&state=${encodeURIComponent(authUrl.searchParams.get("state") ?? "")}`,
        { headers: { cookie: flow ?? "" } },
      ),
      { ...env, DB: broken },
    );
    expect(cb.headers.get("location")).toBe("/?auth=denied");
    // Denied because the session batch failed, not for an earlier reason.
    expect(warn).toHaveBeenLastCalledWith("sign-in denied", "internal_error");
    expect(
      await n("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope = 'auth.flow'"),
    ).toBeGreaterThan(0);
    expect(await auditCount("auth.login")).toBe(before);
    expect(await n("SELECT COUNT(*) AS n FROM sessions")).toBe(sessionsBefore);
  });

  it("step-up sign-in replaces the old session and audits auth.step_up once", async () => {
    await addUser("s2@camelthorncapital.com", ["viewer"], { sub: "sub-s2" });
    const first = await loginAs("s2@camelthorncapital.com", "sub-s2");
    const stub = newStub([key], (nonce, k) =>
      signJwt(
        k,
        claims({
          nonce,
          email: "s2@camelthorncapital.com",
          sub: "sub-s2",
          auth_time: Math.floor(Date.now() / 1000),
        }),
      ),
    );
    stubGoogle(stub);
    const second = await doLogin(stub, { stepUp: true, existingSession: first.sessionToken });
    expect(second.sessionToken).toBeTruthy();
    const uid = await n("SELECT id AS n FROM users WHERE email = 's2@camelthorncapital.com'");
    expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1", uid)).toBe(1);
    expect(await auditCount("auth.step_up")).toBe(1);
  });

  it("concurrent logouts of one session write exactly one auth.logout row", async () => {
    const t = await addSession(adminId);
    const rs = await Promise.all([
      authed("/api/auth/logout", t, { method: "POST" }),
      authed("/api/auth/logout", t, { method: "POST" }),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(await auditCount("auth.logout")).toBe(1);
    expect((await authed("/api/auth/me", t)).status).toBe(401);
  });

  it("router-generated 401, 403, 404, 405 and CSRF answers carry no-store and nosniff", async () => {
    const fin = await addSession(await addUser("h@camelthorncapital.com", ["finance"]));
    const stale = await addSession(adminId, { lastAuthAgoMs: 3600_000 });
    const responses = [
      await worker.fetch(new Request(`${ORIGIN}/api/users`), env), // 401
      await authed("/api/users", fin), // 403
      await authed("/api/users/invite", stale, { method: "POST", json: {} }), // 401 step-up
      await worker.fetch(new Request(`${ORIGIN}/api/nope`), env), // 404
      await authed("/api/users", adminTok, { method: "PUT" }), // 405
      await worker.fetch(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST" }), env), // csrf
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 403, 401, 404, 405, 403]);
    for (const r of responses) {
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-type")).toContain("application/json");
    }
  });

  it("a handler that returns an error Response is passed through untouched", async () => {
    const router = new Router().add("GET", "/api/teapot", { public: true }, () =>
      json({ error: "teapot" }, 418),
    );
    const res = await router.handle(new Request(`${ORIGIN}/api/teapot`), env);
    expect(res?.status).toBe(418);
    expect(await res?.json()).toEqual({ error: "teapot" });
  });

  it("a malformed path escape answers 400 json, not 500", async () => {
    const res = await authed("/api/users/%E0%A4%A/restore", adminTok, {
      method: "POST",
      json: { roles: ["viewer"] },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
