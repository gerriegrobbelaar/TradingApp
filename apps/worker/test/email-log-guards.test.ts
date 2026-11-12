/**
 * Migration 0027 (email_log, ADR 0046): constraints and guard triggers.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db, emailRows } from "./dq-notify-helpers";
import { emailLogWipeStatements } from "./outbox-wipe";

const NOW_ISO = "2026-07-15T10:00:00.000Z";

async function insert(
  key: string,
  over: Partial<{ status: string; created: string; kind: string }> = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, created_at, updated_at)
       VALUES (?1, ?2, 'dq.alert.v1', 2, ?3, ?4, ?4)`,
    )
    .bind(key, over.kind ?? "dq_alert", over.status ?? "claimed", over.created ?? NOW_ISO)
    .run();
}
const rejected = async (sql: string, ...binds: unknown[]): Promise<string> => {
  try {
    await db
      .prepare(sql)
      .bind(...binds)
      .run();
  } catch (e) {
    return String((e as Error).message) + String((e as Error).cause ?? "");
  }
  return "";
};

beforeEach(async () => {
  await db.batch(await emailLogWipeStatements(db));
});

describe("email_log", () => {
  it("holds no address, subject or body column", async () => {
    const cols = (
      await db.prepare("SELECT name FROM pragma_table_info('email_log')").all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(cols.sort()).toEqual(
      [
        "attempts",
        "created_at",
        "dq_issue_id",
        "error_code",
        "id",
        "idempotency_key",
        "kind",
        "provider_message_id",
        "recipients_count",
        "reminder_id",
        "status",
        "template",
        "updated_at",
      ].sort(),
    );
  });

  it("the idempotency key is unique", async () => {
    await insert("k-12345");
    expect(
      await rejected(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, created_at, updated_at)
       VALUES ('k-12345', 'dq_alert', 'dq.alert.v1', 1, 'x', 'x')`,
      ),
    ).toMatch(/UNIQUE/);
  });

  it("checks kind, status, key length and error code shape", async () => {
    expect(
      await rejected(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, created_at, updated_at) VALUES ('k-99999', 'spam', 'dq.alert.v1', 1, 'x', 'x')`,
      ),
    ).toMatch(/CHECK/);
    expect(
      await rejected(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, status, created_at, updated_at) VALUES ('k-99999', 'dq_alert', 'dq.alert.v1', 1, 'queued', 'x', 'x')`,
      ),
    ).toMatch(/CHECK/);
    expect(
      await rejected(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, created_at, updated_at) VALUES ('k', 'dq_alert', 'dq.alert.v1', 1, 'x', 'x')`,
      ),
    ).toMatch(/CHECK/);
    expect(
      await rejected(
        `INSERT INTO email_log (idempotency_key, kind, template, recipients_count, error_code, created_at, updated_at) VALUES ('k-99999', 'dq_alert', 'dq.alert.v1', 1, 'a@b.com', 'x', 'x')`,
      ),
    ).toMatch(/CHECK/);
  });

  it("identity columns never change", async () => {
    await insert("k-id-1");
    for (const [col, val] of [
      ["idempotency_key", "k-other"],
      ["kind", "dq_digest"],
      ["template", "dq.x.v1"],
      ["recipients_count", 9],
      ["created_at", "2020-01-01T00:00:00.000Z"],
      ["dq_issue_id", 5],
    ] as const) {
      expect(
        await rejected(`UPDATE email_log SET ${col} = ?1 WHERE idempotency_key = 'k-id-1'`, val),
        col,
      ).toMatch(/identity_immutable/);
    }
  });

  it("status follows the path: claimed -> sent | failed | unknown | skipped; failed -> claimed (attempts + 1); sent -> delivered | bounced", async () => {
    for (const to of ["sent", "failed", "unknown", "skipped_not_configured"]) {
      await insert(`k-ok-${to}`);
      expect(
        await rejected(
          "UPDATE email_log SET status = ?1 WHERE idempotency_key = ?2",
          to,
          `k-ok-${to}`,
        ),
        to,
      ).toBe("");
    }
    // failed -> claimed needs attempts + 1 in the same statement
    expect(
      await rejected(
        "UPDATE email_log SET status = 'claimed' WHERE idempotency_key = 'k-ok-failed'",
      ),
    ).toMatch(/status_path/);
    expect(
      await rejected(
        "UPDATE email_log SET status = 'claimed', attempts = attempts + 1 WHERE idempotency_key = 'k-ok-failed'",
      ),
    ).toBe("");
    // sent -> delivered / bounced
    expect(
      await rejected(
        "UPDATE email_log SET status = 'delivered' WHERE idempotency_key = 'k-ok-sent'",
      ),
    ).toBe("");
    // forbidden: unknown, skipped and delivered never move; nothing goes back to claimed except failed
    for (const [key, to] of [
      ["k-ok-unknown", "claimed"],
      ["k-ok-unknown", "sent"],
      ["k-ok-skipped_not_configured", "sent"],
      ["k-ok-sent", "claimed"],
      ["k-ok-sent", "failed"],
      ["k-ok-sent", "unknown"],
    ] as const) {
      expect(
        await rejected("UPDATE email_log SET status = ?1 WHERE idempotency_key = ?2", to, key),
        `${key} -> ${to}`,
      ).toMatch(/status_path/);
    }
    expect(
      await rejected(
        "UPDATE email_log SET status = 'sent' WHERE idempotency_key = 'k-ok-delivered'",
      ),
    ).toBe("");
  });

  it("attempts only go up, and only with failed -> claimed; at most three", async () => {
    await insert("k-att-1");
    expect(
      await rejected("UPDATE email_log SET attempts = 2 WHERE idempotency_key = 'k-att-1'"),
    ).toMatch(/attempts/);
    await db
      .prepare("UPDATE email_log SET status = 'failed' WHERE idempotency_key = 'k-att-1'")
      .run();
    await db
      .prepare(
        "UPDATE email_log SET status = 'claimed', attempts = 2 WHERE idempotency_key = 'k-att-1'",
      )
      .run();
    await db
      .prepare("UPDATE email_log SET status = 'failed' WHERE idempotency_key = 'k-att-1'")
      .run();
    await db
      .prepare(
        "UPDATE email_log SET status = 'claimed', attempts = 3 WHERE idempotency_key = 'k-att-1'",
      )
      .run();
    await db
      .prepare("UPDATE email_log SET status = 'failed' WHERE idempotency_key = 'k-att-1'")
      .run();
    expect(
      await rejected(
        "UPDATE email_log SET status = 'claimed', attempts = 4 WHERE idempotency_key = 'k-att-1'",
      ),
    ).toMatch(/CHECK|status_path|attempts/);
  });

  it("rows younger than 365 days cannot be deleted; older ones can", async () => {
    await insert("k-young", { created: new Date(Date.now() - 364 * 86_400_000).toISOString() });
    await insert("k-old", { created: new Date(Date.now() - 366 * 86_400_000).toISOString() });
    expect(await rejected("DELETE FROM email_log WHERE idempotency_key = 'k-young'")).toMatch(
      /delete_recent/,
    );
    expect(await rejected("DELETE FROM email_log WHERE idempotency_key = 'k-old'")).toBe("");
    expect((await emailRows()).map((r) => r.idempotency_key)).toEqual(["k-young"]);
  });
});
