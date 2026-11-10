import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { maskIban, writeAudit } from "../src/db/audit";
import { claimIdempotencyKey, completeIdempotencyKey } from "../src/db/idempotency";
import { seedInitialAdmin } from "../src/db/seed";

const db = env.DB;

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM user_roles"),
    db.prepare("DELETE FROM users"),
    db.prepare("DELETE FROM idempotency_keys"),
  ]);
});

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
    const row = await db.prepare("SELECT * FROM audit_log").first<Record<string, string>>();
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
});

describe("idempotency keys", () => {
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
    await completeIdempotencyKey(db, "k2", { matchSetId: "abc" });
    expect(await claimIdempotencyKey(db, "k2", "exact.matchset")).toEqual({
      status: "duplicate",
      state: "completed",
      result: { matchSetId: "abc" },
    });
  });
});
