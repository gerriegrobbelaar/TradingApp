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
    expect(await auditCount("user.roles_changed")).toBe(2);
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
