import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { maskIban } from "@camelthorn/core";
import { maskDeep, writeAudit } from "../src/db/audit";
import {
  claimIdempotencyKey,
  claimOnceAndPurge,
  completeIdempotencyKey,
} from "../src/db/idempotency";
import { ensureSeeded, resetSeedMemoForTests, seedInitialAdmin } from "../src/db/seed";
import { outboxWipeStatements } from "./outbox-wipe";

const db = env.DB;

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sessions"),
    db.prepare("DELETE FROM user_roles"),
    db.prepare("DELETE FROM users"),
    db.prepare("DELETE FROM idempotency_keys"),
    db.prepare("DELETE FROM settings"),
  ]);
  resetSeedMemoForTests();
});

async function seedDomain(): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO connections (id, kind, name) VALUES (1, 'exact', 'nl')"),
    db.prepare(
      "INSERT INTO divisions (id, connection_id, exact_division, name) VALUES (1, 1, 123, 'BV')",
    ),
    db.prepare(
      "INSERT INTO bank_accounts (id, connection_id, external_id, name, currency) VALUES (1, 1, 'a', 'EUR', 'EUR')",
    ),
    db.prepare(
      "INSERT INTO bank_transactions (id, connection_id, bank_account_id, external_id, state, amount_minor, currency, booked_at) VALUES (1, 1, 1, 'tx1', 'completed', 1250, 'EUR', '2026-01-01T00:00:00Z')",
    ),
    db.prepare(
      "INSERT INTO open_items (id, division_id, exact_id, kind, currency, stored_minor, open_minor, synced_at) VALUES (1, 1, 'e1', 'bill', 'EUR', 1250, 1250, '2026-01-01T00:00:00Z')",
    ),
  ]);
}

async function clearDomain(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM payments"),
    ...(await outboxWipeStatements(db)),
    db.prepare("DELETE FROM match_allocations"),
    db.prepare("DELETE FROM matches"),
    db.prepare("DELETE FROM bank_account_exact_map"),
    db.prepare("DELETE FROM open_items"),
    db.prepare("DELETE FROM bank_transactions"),
    db.prepare("DELETE FROM bank_accounts"),
    db.prepare("DELETE FROM divisions"),
    db.prepare("DELETE FROM connections"),
  ]);
}

describe("schema", () => {
  it("creates all starting tables", async () => {
    const { results } = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of [
      "users",
      "user_roles",
      "invites",
      "sessions",
      "settings",
      "connections",
      "exact_usage",
      "divisions",
      "bank_accounts",
      "bank_transactions",
      "open_items",
      "match_suggestions",
      "matches",
      "payments",
      "payment_batches",
      "approvals",
      "fx_rates",
      "fx_revaluations",
      "jobs",
      "job_runs",
      "dq_rules",
      "dq_issues",
      "reminders",
      "email_log",
      "audit_log",
      "idempotency_keys",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("rejects uppercase emails and duplicate emails", async () => {
    await expect(
      db.prepare("INSERT INTO users (email) VALUES ('A@B.COM')").run(),
    ).rejects.toThrow();
    await db.prepare("INSERT INTO users (email) VALUES ('a@b.com')").run();
    await expect(
      db.prepare("INSERT INTO users (email) VALUES ('a@b.com')").run(),
    ).rejects.toThrow();
  });

  it("rejects unknown roles", async () => {
    await db.prepare("INSERT INTO users (email) VALUES ('a@b.com')").run();
    await expect(
      db.prepare("INSERT INTO user_roles (user_id, role) SELECT id, 'root' FROM users").run(),
    ).rejects.toThrow();
  });

  it("enforces unique (connection, external id) on bank transactions", async () => {
    await db.batch([
      db.prepare("INSERT INTO connections (id, kind, name) VALUES (1, 'revolut', 'main')"),
      db.prepare(
        "INSERT INTO bank_accounts (id, connection_id, external_id, name, currency) VALUES (1, 1, 'a', 'EUR', 'EUR')",
      ),
    ]);
    const ins = () =>
      db
        .prepare(
          "INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, state, amount_minor, currency, booked_at) VALUES (1, 1, 'tx1', 'completed', -1250, 'EUR', '2026-01-01T00:00:00Z')",
        )
        .run();
    await ins();
    await expect(ins()).rejects.toThrow();
    await db.batch([
      db.prepare("DELETE FROM bank_transactions"),
      db.prepare("DELETE FROM bank_accounts"),
      db.prepare("DELETE FROM connections"),
    ]);
  });

  it("stops an approver approving their own request", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO approvals (subject_type, subject_id, requested_by, status, decided_by) VALUES ('payment', '1', 'a@b.com', 'approved', 'A@b.com')",
        )
        .run(),
    ).rejects.toThrow();
  });

  it("stores only a SHA-256 hex hash as the session key", async () => {
    await db.prepare("INSERT INTO users (id, email) VALUES (1, 'a@b.com')").run();
    const ins = (h: string) =>
      db
        .prepare(
          "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, last_auth_at) VALUES (?1, 1, 'x', 'x', 'x', 'x')",
        )
        .bind(h)
        .run();
    await expect(ins("raw-session-token")).rejects.toThrow();
    await expect(ins("A".repeat(64))).rejects.toThrow();
    await ins("a".repeat(64));
  });

  it("rejects non-decimal FX rates and bad currency codes", async () => {
    const ins = (cur: string, rate: string) =>
      db
        .prepare("INSERT INTO fx_rates (currency, rate_date, rate) VALUES (?1, '2026-01-02', ?2)")
        .bind(cur, rate)
        .run();
    await expect(ins("USD", "1.08e0")).rejects.toThrow();
    await expect(ins("USD", "1.0.8")).rejects.toThrow();
    await expect(ins("usd", "1.0812")).rejects.toThrow();
    await expect(ins("US", "1.0812")).rejects.toThrow();
    await ins("USD", "1.0812");
    await db.prepare("DELETE FROM fx_rates").run();
  });

  it("allows only one in-flight payment per open item", async () => {
    await seedDomain();
    const pay = (req: string, status: string) =>
      db
        .prepare(
          "INSERT INTO payments (open_item_id, status, amount_minor, currency, beneficiary_iban, request_id, created_by) VALUES (1, ?2, 1250, 'EUR', 'NL91ABNA0417164300', ?1, 'a@b.com')",
        )
        .bind(req, status)
        .run();
    await pay("r1", "paying");
    await expect(pay("r2", "waiting_approval")).rejects.toThrow();
    await expect(pay("r1", "failed")).rejects.toThrow(); // request_id is unique
    await pay("r3", "failed");
    await clearDomain();
  });

  it("allows only one live match per bank line", async () => {
    await seedDomain();
    // The match guard needs a synced administration (migration 0022).
    await db.prepare("UPDATE divisions SET sync_enabled = 1 WHERE id = 1").run();
    await db
      .prepare(
        "INSERT INTO bank_account_exact_map (bank_account_id, division_id, journal_code, bank_gl_account_code, created_by, updated_by) VALUES (1, 1, '90', '1210', 'a@b.com', 'a@b.com')",
      )
      .run();
    const match = () =>
      db
        .prepare(
          "INSERT INTO matches (bank_transaction_id, division_id, source, ledger_account_code, amount_minor, currency, created_by) VALUES (1, 1, 'ledger', '1300', 1250, 'EUR', 'a@b.com')",
        )
        .run();
    await match();
    await expect(match()).rejects.toThrow();
    await db.prepare("UPDATE matches SET undone_at = 'now', undone_by = 'a@b.com'").run();
    await db.prepare("UPDATE bank_transactions SET match_status = 'unmatched'").run();
    await match();
    await clearDomain();
  });
});

describe("seedInitialAdmin", () => {
  it("creates one admin with a lowercased email", async () => {
    expect(await seedInitialAdmin(db, "  Admin@Example.COM ")).toBe("created");
    const row = await db
      .prepare(
        "SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'admin'",
      )
      .all<{ email: string }>();
    expect(row.results).toEqual([{ email: "admin@example.com" }]);
  });

  it("is idempotent when run twice", async () => {
    await seedInitialAdmin(db, "admin@example.com");
    expect(await seedInitialAdmin(db, "admin@example.com")).toBe("exists");
    expect(await count("users")).toBe(1);
    expect(await count("user_roles")).toBe(1);
  });

  it("never creates a second admin with a different email", async () => {
    await seedInitialAdmin(db, "admin@example.com");
    await seedInitialAdmin(db, "other@example.com");
    expect(await count("users")).toBe(1);
    expect(await count("user_roles")).toBe(1);
  });

  it("is a no-op on empty email", async () => {
    expect(await seedInitialAdmin(db, "")).toBe("skipped");
    expect(await seedInitialAdmin(db, "   ")).toBe("skipped");
    expect(await seedInitialAdmin(db, undefined)).toBe("skipped");
    expect(await count("users")).toBe(0);
  });

  it("promotes an existing non-admin user with that email", async () => {
    await db.prepare("INSERT INTO users (email) VALUES ('admin@example.com')").run();
    expect(await seedInitialAdmin(db, "admin@example.com")).toBe("created");
    expect(await count("users")).toBe(1);
    expect(await count("user_roles")).toBe(1);
  });

  it("is race-safe when several isolates seed at once", async () => {
    const results = await Promise.all([
      seedInitialAdmin(db, "admin@example.com"),
      seedInitialAdmin(db, "admin@example.com"),
      seedInitialAdmin(db, "other@example.com"),
    ]);
    expect(results.filter((r) => r === "created")).toHaveLength(1);
    expect(await count("user_roles")).toBe(1);
  });

  it("writes one audit entry for the seed", async () => {
    await seedInitialAdmin(db, "admin@example.com");
    await seedInitialAdmin(db, "admin@example.com");
    const user = await db
      .prepare("SELECT id FROM users WHERE email = 'admin@example.com'")
      .first<{ id: number }>();
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.seed_admin' AND entity_id = ?1",
      )
      .bind(String(user?.id))
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("does not re-grant admin after the seeded admin was removed", async () => {
    await seedInitialAdmin(db, "admin@example.com");
    await db.prepare("DELETE FROM user_roles").run();
    expect(await seedInitialAdmin(db, "admin@example.com")).toBe("exists");
    expect(await count("user_roles")).toBe(0);
  });

  it("rejects an invalid configured email", async () => {
    await expect(seedInitialAdmin(db, "not-an-email")).rejects.toThrow();
    expect(await count("users")).toBe(0);
  });

  it("works for the configured Workers variable", async () => {
    await ensureSeeded(env);
    const row = await db
      .prepare(
        "SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'admin'",
      )
      .first<{ email: string }>();
    expect(row?.email).toBe(env.INITIAL_ADMIN_EMAIL.toLowerCase());
  });

  it("ensureSeeded retries after a failure instead of giving up for the isolate", async () => {
    let calls = 0;
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return (stmts: D1PreparedStatement[]) => {
            calls += 1;
            if (calls === 1) return Promise.reject(new Error("D1 unavailable"));
            return target.batch(stmts);
          };
        }
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const e = { DB: failingDb, INITIAL_ADMIN_EMAIL: "admin@example.com" };
    await expect(ensureSeeded(e)).rejects.toThrow("D1 unavailable");
    await ensureSeeded(e);
    expect(calls).toBe(2);
    expect(await count("user_roles")).toBe(1);
    await ensureSeeded(e); // memoised after success
    expect(calls).toBe(2);
  });
});

describe("audit log", () => {
  it("appends entries and masks IBANs", async () => {
    await writeAudit(db, {
      actorEmail: "Gerrie@Example.com",
      action: "supplier.iban.change",
      entity: "supplier",
      entityId: 42,
      before: { iban: "NL91ABNA0417164300" },
      after: { iban: "DE89370400440532013000", note: "moved to DE89370400440532013000 today" },
    });
    const row = await db
      .prepare("SELECT * FROM audit_log WHERE action = 'supplier.iban.change'")
      .first<Record<string, string>>();
    expect(row?.actor_email).toBe("gerrie@example.com");
    expect(row?.entity_id).toBe("42");
    expect(row?.before_json).toContain("NL91****4300");
    expect(row?.before_json).not.toContain("ABNA0417164300");
    expect(row?.after_json).not.toContain("DE89370400440532013000");
    expect(row?.after_json).toContain("DE89****3000");
  });

  it("is append-only", async () => {
    await writeAudit(db, { actorEmail: "a@b.com", action: "x", entity: "y" });
    await expect(db.prepare("UPDATE audit_log SET action = 'z'").run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM audit_log").run()).rejects.toThrow();
  });

  it("masks short and spaced IBANs", () => {
    expect(maskIban("NL91 ABNA 0417 1643 00")).toBe("NL91****4300");
    expect(maskIban("NL91")).toBe("****");
  });

  it("masks spaced and lowercase IBANs inside free text and in entity ids", async () => {
    const out = JSON.stringify(
      maskDeep({
        note: "pay NL91 ABNA 0417 1643 00 and nl91abna0417164300 now",
        list: ["GB82WEST12345698765432"],
      }),
    );
    expect(out).not.toMatch(/0417\s?1643/i);
    expect(out).not.toContain("WEST1234");
    expect(out).toContain("NL91****4300");
    expect(out).toContain("now");
    await writeAudit(db, {
      actorEmail: "a@b.com",
      action: "counterparty.create",
      entity: "counterparty",
      entityId: "NL91ABNA0417164300",
    });
    const row = await db
      .prepare("SELECT entity_id FROM audit_log WHERE action = 'counterparty.create'")
      .first<{ entity_id: string }>();
    expect(row?.entity_id).toBe("NL91****4300");
  });

  it("redacts tokens, secrets and email bodies", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl";
    const out = JSON.stringify(
      maskDeep({
        access_token: "abc123",
        refreshToken: "def456",
        client_secret: "s3cr3t",
        headers: { Authorization: "Bearer xyz789" },
        body: "Dear customer",
        message: `got ${jwt} and Bearer qwe321`,
        amount_minor: 1250,
        when: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    for (const secret of ["abc123", "def456", "s3cr3t", "xyz789", "Dear customer", jwt, "qwe321"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('"amount_minor":1250');
    expect(out).toContain("2026-01-01T00:00:00.000Z");
  });

  it("keeps result codes but still redacts authorization codes under their qualified names", () => {
    const out = maskDeep({
      code: "rate_limited",
      failure: "api_500",
      summary: { code: "walk_incomplete", errorCode: "needs_reauth" },
      authorization_code: "4/0AX4XfWh-secret-a",
      authCode: "secret-b",
      oauth_code: "secret-c",
      grantCode: "secret-d",
      code_verifier: "secret-e",
      codeVerifier: "secret-f",
      access_token: "secret-g",
      webhookSigningSecret: "secret-h",
    }) as Record<string, unknown>;
    expect(out["code"]).toBe("rate_limited");
    expect(out["failure"]).toBe("api_500");
    expect(out["summary"]).toEqual({ code: "walk_incomplete", errorCode: "needs_reauth" });
    const text = JSON.stringify(out);
    for (const s of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      expect(text).not.toContain(`secret-${s}`);
    }
  });

  it("rejects an empty actor", async () => {
    await expect(writeAudit(db, { actorEmail: " ", action: "x", entity: "y" })).rejects.toThrow();
  });
});

describe("idempotency keys", () => {
  it("claimOnceAndPurge: one winner, bounded purge of old keys in its own scope only", async () => {
    const opts = { nowMs: Date.now(), retentionMs: 3600_000, purgeLimit: 2 };
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const put = (scope: string, k: string, at: string) =>
      db
        .prepare(
          "INSERT INTO idempotency_keys (scope, key, status, created_at) VALUES (?1, ?2, 'completed', ?3)",
        )
        .bind(scope, k, at);
    await db.batch([
      put("auth.flow", "a", old),
      put("auth.flow", "b", old),
      put("auth.flow", "c", old),
      put("auth.flow", "fresh", recent),
      put("revolut.pay", "p", old),
      put("auth.flowx", "q", old),
    ]);
    const n = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n;
    const oldLeft = () =>
      n(
        "SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope='auth.flow' AND key IN ('a','b','c')",
      );

    // One call purges exactly purgeLimit old keys.
    expect(await claimOnceAndPurge(db, "first", "auth.flow", opts)).toBe(true);
    expect(await oldLeft()).toBe(1);

    // Concurrent claims of one key: exactly one winner, and the claim itself is never purged.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => claimOnceAndPurge(db, "once", "auth.flow", opts)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimOnceAndPurge(db, "once", "auth.flow", opts)).toBe(false);
    expect(await claimOnceAndPurge(db, "first", "auth.flow", opts)).toBe(false);
    expect(await oldLeft()).toBe(0);

    // Recent keys and other scopes are untouched.
    expect(
      await n("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope='auth.flow' AND key='fresh'"),
    ).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope<>'auth.flow'")).toBe(2);
  });

  it("claimOnceAndPurge refuses non-allow-listed scopes and unsafe options", async () => {
    const opts = { nowMs: Date.now(), retentionMs: 3600_000, purgeLimit: 2 };
    for (const scope of ["revolut.pay", "auth.", "auth.flowx", "auth.flow ", "AUTH.FLOW"]) {
      await expect(claimOnceAndPurge(db, "x", scope, opts), scope).rejects.toThrow(/not purgeable/);
    }
    await expect(claimOnceAndPurge(db, "", "auth.flow", opts)).rejects.toThrow(/non-empty/);
    for (const retentionMs of [0, -1, 60_000, Number.NaN]) {
      await expect(
        claimOnceAndPurge(db, "x", "auth.flow", { ...opts, retentionMs }),
      ).rejects.toThrow(/retention/);
    }
    for (const purgeLimit of [0, -1, 1.5, 10_000]) {
      await expect(
        claimOnceAndPurge(db, "x", "auth.flow", { ...opts, purgeLimit }),
      ).rejects.toThrow(/purgeLimit/);
    }
    expect(await count("idempotency_keys")).toBe(0);
  });

  it("claims once, then reports duplicates", async () => {
    expect(await claimIdempotencyKey(db, "k1", "revolut.pay")).toEqual({ status: "claimed" });
    expect(await claimIdempotencyKey(db, "k1", "revolut.pay")).toEqual({
      status: "duplicate",
      state: "pending",
      result: null,
    });
  });

  it("returns the stored result after completion", async () => {
    await claimIdempotencyKey(db, "k2", "exact.matchset");
    await completeIdempotencyKey(db, "k2", "exact.matchset", { matchSetId: "abc" });
    expect(await claimIdempotencyKey(db, "k2", "exact.matchset")).toEqual({
      status: "duplicate",
      state: "completed",
      result: { matchSetId: "abc" },
    });
  });

  it("gives exactly one claim to concurrent callers", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimIdempotencyKey(db, "k3", "revolut.pay")),
    );
    expect(results.filter((r) => r.status === "claimed")).toHaveLength(1);
  });

  it("keeps scopes separate", async () => {
    await claimIdempotencyKey(db, "k4", "revolut.pay");
    await completeIdempotencyKey(db, "k4", "revolut.pay", { id: "p1" });
    expect(await claimIdempotencyKey(db, "k4", "exact.matchset")).toEqual({ status: "claimed" });
  });

  it("refuses to complete an unclaimed or already completed key", async () => {
    await expect(completeIdempotencyKey(db, "nope", "revolut.pay", {})).rejects.toThrow();
    await claimIdempotencyKey(db, "k5", "revolut.pay");
    await completeIdempotencyKey(db, "k5", "revolut.pay", { id: "p1" });
    await expect(completeIdempotencyKey(db, "k5", "revolut.pay", { id: "p2" })).rejects.toThrow();
    expect(await claimIdempotencyKey(db, "k5", "revolut.pay")).toMatchObject({
      result: { id: "p1" },
    });
  });

  it("rejects empty keys", async () => {
    await expect(claimIdempotencyKey(db, "", "revolut.pay")).rejects.toThrow();
    await expect(claimIdempotencyKey(db, "k", " ")).rejects.toThrow();
  });
});
