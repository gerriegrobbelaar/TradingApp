import { beforeEach, describe, expect, it } from "vitest";
import { addSession, addUser, authed, db, resetDb } from "./helpers";

const ADMIN = "gerrie.grobbelaar@camelthorncapital.com";
let adminId: number;
let adminTok: string;

beforeEach(async () => {
  await resetDb();
  adminId = await addUser(ADMIN, ["admin"]);
  adminTok = await addSession(adminId);
});

const count = async (sql: string, ...b: unknown[]): Promise<number> =>
  (
    await db
      .prepare(sql)
      .bind(...b)
      .first<{ n: number }>()
  )?.n ?? -1;

describe("GET /api/users", () => {
  it("lists users with roles and pending invites; reading needs no step-up", async () => {
    const stale = await addSession(adminId, { lastAuthAgoMs: 3 * 3600 * 1000 });
    await addUser("f@camelthorncapital.com", ["finance", "approver"]);
    await db
      .prepare(
        "INSERT INTO invites (email, roles, invited_by) VALUES ('i@camelthorncapital.com','[\"viewer\"]',?1)",
      )
      .bind(ADMIN)
      .run();
    const res = await authed("/api/users", stale);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: { email: string; roles: string[]; disabled: boolean }[];
      invites: { email: string; roles: string[] }[];
    };
    expect(body.users.find((u) => u.email === "f@camelthorncapital.com")?.roles).toEqual([
      "approver",
      "finance",
    ]);
    expect(body.invites).toEqual([
      expect.objectContaining({ email: "i@camelthorncapital.com", roles: ["viewer"] }),
    ]);
    expect(JSON.stringify(body)).not.toMatch(/google_sub|token/i);
  });
});

describe("POST /api/users/invite", () => {
  const post = (json: unknown) => authed("/api/users/invite", adminTok, { method: "POST", json });

  it("creates a lowercase invite and audits it under the actor", async () => {
    const res = await post({ email: " New@CamelthornCapital.com ", roles: ["finance", "finance"] });
    expect(res.status).toBe(201);
    const inv = await db.prepare("SELECT email, roles, invited_by FROM invites").first();
    expect(inv).toEqual({
      email: "new@camelthorncapital.com",
      roles: '["finance"]',
      invited_by: ADMIN,
    });
    const a = await db
      .prepare("SELECT actor_email, action FROM audit_log WHERE action = 'user.invite'")
      .first();
    expect(a).toEqual({ actor_email: ADMIN, action: "user.invite" });
  });

  it("rejects external domains, bad emails and bad roles with 400", async () => {
    for (const body of [
      { email: "x@gmail.com", roles: ["viewer"] },
      { email: "x@camelthorncapital.com.evil.com", roles: ["viewer"] },
      { email: "nope", roles: ["viewer"] },
      { email: "x@camelthorncapital.com", roles: [] },
      { email: "x@camelthorncapital.com", roles: ["root"] },
      { email: "x@camelthorncapital.com" },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(await count("SELECT COUNT(*) AS n FROM invites")).toBe(0);
  });

  it("rejects duplicates with 409", async () => {
    expect((await post({ email: "d@camelthorncapital.com", roles: ["viewer"] })).status).toBe(201);
    expect((await post({ email: "d@camelthorncapital.com", roles: ["viewer"] })).status).toBe(409);
    expect((await post({ email: ADMIN, roles: ["viewer"] })).status).toBe(409);
  });
});

describe("POST /api/users/invite (races)", () => {
  it("two concurrent invites for the same email: one 201, one 409, no 500", async () => {
    const body = { email: "race@camelthorncapital.com", roles: ["viewer"] };
    const rs = await Promise.all([
      authed("/api/users/invite", adminTok, { method: "POST", json: body }),
      authed("/api/users/invite", adminTok, { method: "POST", json: body }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe("PATCH /api/users/:id/roles", () => {
  it("changes roles, audits before/after, and kills sessions when a role is removed", async () => {
    const uid = await addUser("f@camelthorncapital.com", ["finance", "approver"]);
    const ut = await addSession(uid);
    const res = await authed(`/api/users/${uid}/roles`, adminTok, {
      method: "PATCH",
      json: { roles: ["finance"] },
    });
    expect(res.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1", uid)).toBe(0);
    expect((await authed("/api/auth/me", ut)).status).toBe(401);
    const a = await db
      .prepare(
        "SELECT actor_email, before_json, after_json FROM audit_log WHERE action = 'user.roles_changed'",
      )
      .first<{ actor_email: string; before_json: string; after_json: string }>();
    expect(a?.actor_email).toBe(ADMIN);
    expect(JSON.parse(a?.before_json ?? "")).toEqual({ roles: ["approver", "finance"] });
    expect(JSON.parse(a?.after_json ?? "")).toEqual({ roles: ["finance"] });
  });

  it("keeps sessions when roles are only added", async () => {
    const uid = await addUser("f@camelthorncapital.com", ["viewer"]);
    const ut = await addSession(uid);
    await authed(`/api/users/${uid}/roles`, adminTok, {
      method: "PATCH",
      json: { roles: ["viewer", "finance"] },
    });
    const me = await authed("/api/auth/me", ut);
    expect(await me.json()).toMatchObject({ roles: ["finance", "viewer"] });
  });

  it("protects the last admin from demotion, allows it when another admin exists", async () => {
    const res = await authed(`/api/users/${adminId}/roles`, adminTok, {
      method: "PATCH",
      json: { roles: ["viewer"] },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "last_admin" });
    expect(await count("SELECT COUNT(*) AS n FROM user_roles WHERE role = 'admin'")).toBe(1);

    const second = await addUser("b@camelthorncapital.com", ["admin"]);
    const ok = await authed(`/api/users/${adminId}/roles`, adminTok, {
      method: "PATCH",
      json: { roles: ["viewer"] },
    });
    expect(ok.status).toBe(200);
    // Now `second` is the last admin.
    const secondTok = await addSession(second);
    const again = await authed(`/api/users/${second}/roles`, secondTok, {
      method: "PATCH",
      json: { roles: [] },
    });
    expect(again.status).toBe(409);
  });

  it("last-admin guard holds under concurrent demotions and removals", async () => {
    const second = await addUser("b@camelthorncapital.com", ["admin"]);
    const secondTok = await addSession(second);
    const results = await Promise.all([
      authed(`/api/users/${adminId}/roles`, secondTok, {
        method: "PATCH",
        json: { roles: ["viewer"] },
      }),
      authed(`/api/users/${second}`, adminTok, { method: "DELETE" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM user_roles r JOIN users u ON u.id = r.user_id
         WHERE r.role = 'admin' AND u.disabled_at IS NULL`,
      ),
    ).toBe(1);
  });

  it("a disabled admin does not count as another admin", async () => {
    await addUser("gone@camelthorncapital.com", ["admin"], { disabled: true });
    const res = await authed(`/api/users/${adminId}/roles`, adminTok, {
      method: "PATCH",
      json: { roles: [] },
    });
    expect(res.status).toBe(409);
  });

  it("validates input and unknown ids", async () => {
    expect(
      (
        await authed(`/api/users/${adminId}/roles`, adminTok, {
          method: "PATCH",
          json: { roles: ["x"] },
        })
      ).status,
    ).toBe(400);
    for (const bad of ["abc", "1e0", "0x1", "%201", "-1", "0", "1.0", "99999999999999999999"]) {
      expect(
        (
          await authed(`/api/users/${bad}/roles`, adminTok, {
            method: "PATCH",
            json: { roles: [] },
          })
        ).status,
        bad,
      ).toBe(400);
    }
    expect(
      (await authed("/api/users/9999/roles", adminTok, { method: "PATCH", json: { roles: [] } }))
        .status,
    ).toBe(404);
  });
});

describe("DELETE /api/users/:id", () => {
  it("disables the user, deletes sessions at once and audits", async () => {
    const uid = await addUser("f@camelthorncapital.com", ["finance"]);
    const ut = await addSession(uid);
    const res = await authed(`/api/users/${uid}`, adminTok, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1", uid)).toBe(0);
    expect((await authed("/api/auth/me", ut)).status).toBe(401);
    expect(
      await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1 AND disabled_at IS NOT NULL", uid),
    ).toBe(1);
    const a = await db
      .prepare("SELECT actor_email FROM audit_log WHERE action = 'user.disabled'")
      .first();
    expect(a).toEqual({ actor_email: ADMIN });
    // Idempotent.
    expect((await authed(`/api/users/${uid}`, adminTok, { method: "DELETE" })).status).toBe(200);
  });

  it("cannot remove the last admin (not even yourself)", async () => {
    const res = await authed(`/api/users/${adminId}`, adminTok, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL")).toBe(1);
    expect((await authed("/api/auth/me", adminTok)).status).toBe(200);
  });

  it("404 for unknown users", async () => {
    expect((await authed("/api/users/9999", adminTok, { method: "DELETE" })).status).toBe(404);
  });
});
