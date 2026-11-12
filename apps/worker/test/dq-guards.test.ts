/**
 * Migration 0026: the schema checks and guard triggers of the data quality tables, and source scans
 * for the rules of ADR 0045 (no Exact or Revolut call, no full IBAN, no float money).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db, resetDq } from "./dq-helpers";

const NOW = "2026-07-15T10:00:00.000Z";
let n = 0;

async function insertIssue(over: Record<string, string | number | null> = {}): Promise<number> {
  const v = {
    division_id: 0,
    rule_id: "fx.rate_stale",
    fingerprint: `fx.rate_stale:t${++n}`,
    area: "fx",
    severity: "warning",
    status: "open",
    subject: "s",
    message: "m",
    fix: "fx",
    first_seen_at: NOW,
    last_seen_at: NOW,
    resolved_at: null,
    snoozed_until: null,
    ...over,
  };
  const r = await db
    .prepare(
      `INSERT INTO dq_issues (division_id, rule_id, fingerprint, area, severity, status, subject, message, fix,
         first_seen_at, last_seen_at, resolved_at, snoozed_until)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      v.division_id,
      v.rule_id,
      v.fingerprint,
      v.area,
      v.severity,
      v.status,
      v.subject,
      v.message,
      v.fix,
      v.first_seen_at,
      v.last_seen_at,
      v.resolved_at,
      v.snoozed_until,
    )
    .run();
  return r.meta.last_row_id;
}

const fails = async (sql: string, ...binds: (string | number | null)[]): Promise<string> => {
  try {
    await db
      .prepare(sql)
      .bind(...binds)
      .run();
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`expected a constraint error: ${sql}`);
};

beforeEach(resetDq);

describe("dq_issues guard triggers", () => {
  it("rule, division, fingerprint and first_seen_at never change", async () => {
    const id = await insertIssue();
    for (const [col, val] of [
      ["fingerprint", "fx.rate_stale:other"],
      ["rule_id", "fx.rate_conflicts"],
      ["division_id", 5],
      ["first_seen_at", "2020-01-01T00:00:00.000Z"],
    ] as const) {
      expect(await fails(`UPDATE dq_issues SET ${col} = ?2 WHERE id = ?1`, id, val), col).toContain(
        "dq_err:identity_immutable",
      );
    }
    // setting a column to its own value is not a change
    await db.prepare("UPDATE dq_issues SET fingerprint = fingerprint WHERE id = ?1").bind(id).run();
    // the fields a run refreshes are free to move
    await db
      .prepare(
        "UPDATE dq_issues SET last_seen_at = ?2, severity = 'critical', message = 'x' WHERE id = ?1",
      )
      .bind(id, "2026-07-16T00:00:00.000Z")
      .run();
  });

  it("a resolved issue reopens only through the explicit path (reopen_count + 1 in the same statement)", async () => {
    const id = await insertIssue({ status: "resolved", resolved_at: NOW });
    expect(
      await fails("UPDATE dq_issues SET status = 'open', resolved_at = NULL WHERE id = ?1", id),
    ).toContain("dq_err:reopen_path");
    expect(
      await fails(
        "UPDATE dq_issues SET status = 'snoozed', resolved_at = NULL, snoozed_until = ?2 WHERE id = ?1",
        id,
        NOW,
      ),
    ).toContain("dq_err:reopen_path");
    expect(
      await fails(
        "UPDATE dq_issues SET status = 'open', resolved_at = NULL, reopen_count = reopen_count + 2 WHERE id = ?1",
        id,
      ),
    ).toContain("dq_err:reopen_path");
    await db
      .prepare(
        "UPDATE dq_issues SET status = 'open', resolved_at = NULL, reopen_count = reopen_count + 1 WHERE id = ?1",
      )
      .bind(id)
      .run();
    const row = await db
      .prepare("SELECT status, reopen_count FROM dq_issues WHERE id = ?1")
      .bind(id)
      .first();
    expect(row).toEqual({ status: "open", reopen_count: 1 });
  });

  it("open, snoozed and resolved changes that do not reopen are free", async () => {
    const id = await insertIssue();
    await db
      .prepare("UPDATE dq_issues SET status = 'snoozed', snoozed_until = ?2 WHERE id = ?1")
      .bind(id, NOW)
      .run();
    await db
      .prepare("UPDATE dq_issues SET status = 'open', snoozed_until = NULL WHERE id = ?1")
      .bind(id)
      .run();
    await db
      .prepare("UPDATE dq_issues SET status = 'resolved', resolved_at = ?2 WHERE id = ?1")
      .bind(id, NOW)
      .run();
  });

  it("reopen_count never goes down", async () => {
    const id = await insertIssue();
    await db.prepare("UPDATE dq_issues SET reopen_count = 3 WHERE id = ?1").bind(id).run();
    expect(await fails("UPDATE dq_issues SET reopen_count = 2 WHERE id = ?1", id)).toContain(
      "dq_err:counter_down",
    );
  });

  it("only resolved history can be deleted", async () => {
    const open = await insertIssue();
    const snoozed = await insertIssue({ status: "snoozed", snoozed_until: NOW });
    const resolved = await insertIssue({ status: "resolved", resolved_at: NOW });
    for (const id of [open, snoozed]) {
      expect(await fails("DELETE FROM dq_issues WHERE id = ?1", id)).toContain(
        "dq_err:delete_live",
      );
    }
    await db.prepare("DELETE FROM dq_issues WHERE id = ?1").bind(resolved).run();
  });
});

describe("table checks", () => {
  it("one issue per division and fingerprint", async () => {
    await insertIssue({ fingerprint: "fx.rate_stale:same" });
    await expect(insertIssue({ fingerprint: "fx.rate_stale:same" })).rejects.toThrow();
    await insertIssue({ fingerprint: "fx.rate_stale:same", division_id: 1 });
  });

  it("status and its timestamps agree", async () => {
    await expect(insertIssue({ status: "snoozed" })).rejects.toThrow();
    await expect(insertIssue({ snoozed_until: NOW })).rejects.toThrow();
    await expect(insertIssue({ status: "resolved" })).rejects.toThrow();
    await expect(insertIssue({ resolved_at: NOW })).rejects.toThrow();
    await expect(insertIssue({ status: "bogus" })).rejects.toThrow();
    await expect(insertIssue({ severity: "urgent" })).rejects.toThrow();
    await expect(insertIssue({ area: "other" })).rejects.toThrow();
  });

  it("payload is JSON of bounded size; money is an integer", async () => {
    const id = await insertIssue();
    expect(
      await fails("UPDATE dq_issues SET payload_json = 'not json' WHERE id = ?1", id),
    ).toContain("CHECK");
    expect(
      await fails(
        "UPDATE dq_issues SET payload_json = ?2 WHERE id = ?1",
        id,
        JSON.stringify({ a: "x".repeat(4001) }),
      ),
    ).toContain("CHECK");
    expect(await fails("UPDATE dq_issues SET amount_minor = 1.5 WHERE id = ?1", id)).toContain(
      "CHECK",
    );
    expect(await fails("UPDATE dq_issues SET currency = 'eur' WHERE id = ?1", id)).toContain(
      "CHECK",
    );
  });

  it("a rule that was not evaluated needs a reason and has no issue count", async () => {
    const ins = (status: string, reason: string | null, count: number) =>
      db
        .prepare(
          `INSERT INTO dq_rule_status (division_id, rule_id, status, reason, issue_count, evaluated_at)
           VALUES (0, 'x.rule', ?1, ?2, ?3, ?4) ON CONFLICT (division_id, rule_id) DO UPDATE SET status = ?1, reason = ?2, issue_count = ?3`,
        )
        .bind(status, reason, count, NOW)
        .run();
    await ins("ok", null, 0);
    await ins("issues", null, 3);
    await expect(ins("not_available", null, 0)).rejects.toThrow();
    await expect(ins("not_available", "no_data", 2)).rejects.toThrow();
    await expect(ins("not_configured", "No Data", 0)).rejects.toThrow();
    await ins("not_available", "no_data", 0);
    await expect(ins("fine", null, 0)).rejects.toThrow();
  });

  it("rule overrides: known severity, valid JSON, lower-case id", async () => {
    const ins = (id: string, sev: string | null, thr: string | null) =>
      db
        .prepare(
          "INSERT INTO dq_rules (id, severity, threshold_json, rev, updated_by, updated_at) VALUES (?1, ?2, ?3, 'r', 'a', ?4)",
        )
        .bind(id, sev, thr, NOW)
        .run();
    await ins("bank.unmatched_old", "critical", '{"value":3}');
    await expect(ins("bank.other", "urgent", null)).rejects.toThrow();
    await expect(ins("bank.other", null, "{nope")).rejects.toThrow();
    await expect(ins("Bank.Other", null, null)).rejects.toThrow();
  });

  it("the run row is keyed by the job run", async () => {
    const ins = () =>
      db
        .prepare("INSERT INTO dq_runs (job_run_id, started_at, engine_version) VALUES (7, ?1, '1')")
        .bind(NOW)
        .run();
    await ins();
    await expect(ins()).rejects.toThrow();
  });

  it("bank_accounts got the Exact balance columns, integer only", async () => {
    const cols = (
      await db.prepare("PRAGMA table_info(bank_accounts)").all<{ name: string }>()
    ).results.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["exact_balance_minor", "exact_balance_at"]));
    const conn = await db
      .prepare(
        "INSERT INTO connections (kind, name, status) VALUES ('revolut', 'dq-guard', 'active')",
      )
      .run();
    const acc = await db
      .prepare(
        "INSERT INTO bank_accounts (connection_id, external_id, name, currency) VALUES (?1, 'dq-g', 'n', 'EUR')",
      )
      .bind(conn.meta.last_row_id)
      .run();
    expect(
      await fails(
        "UPDATE bank_accounts SET exact_balance_minor = 1.5 WHERE id = ?1",
        acc.meta.last_row_id,
      ),
    ).toContain("CHECK");
    await db.prepare("DELETE FROM bank_accounts WHERE id = ?1").bind(acc.meta.last_row_id).run();
    await db.prepare("DELETE FROM connections WHERE id = ?1").bind(conn.meta.last_row_id).run();
  });
});

describe("source scans (ADR 0045)", () => {
  const files = (
    import.meta as unknown as { glob: (p: string | string[], o: object) => Record<string, string> }
  ).glob(["../src/dq/*.ts", "../../../packages/core/src/dq/*.ts", "!**/*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const names = Object.keys(files);

  it("sees the files", () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names.some((f) => f.endsWith("src/dq/load.ts"))).toBe(true);
    expect(names.some((f) => f.endsWith("rules-bank.ts"))).toBe(true);
  });

  it("the check job and the rules make no call to Exact or Revolut", () => {
    for (const [f, src] of Object.entries(files)) {
      expect(src, f).not.toMatch(
        /createExactClient|createGateTransport|getExactGate|EXACT_GATE|REVOLUT_GATE|\bfetch\s*\(|@camelthorn\/(exact|revolut)/,
      );
    }
  });

  it("no code reads an IBAN column, and nothing logs rows", () => {
    for (const [f, src] of Object.entries(files)) {
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      expect(code, f).not.toMatch(
        /(counterparty|relation|beneficiary)_iban\b|\w\.iban\b|\bselect\b[^;`]*\biban\b/i,
      );
      expect(code, f).not.toMatch(/console\.(log|info|debug|warn)\s*\(/);
    }
  });

  it("money is integers: no float parsing, rounding or division by 100", () => {
    for (const [f, src] of Object.entries(files)) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(
        /parseFloat|toFixed|Math\.(round|floor|ceil)\([^)]*\/\s*100|\/\s*100\b|\*\s*0\.\d|\bREAL\b|\bFLOAT\b/,
      );
    }
  });

  it("the migration stores no float and no full IBAN column", () => {
    const sql = (
      import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }
    ).glob("../migrations/0026_data_quality.sql", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const text = Object.values(sql)[0] as string;
    expect(text).not.toMatch(/\bREAL\b|\bFLOAT\b|\bDOUBLE\b/i);
    expect(text.replace(/--.*$/gm, "")).not.toMatch(/\biban\b/i);
  });
});
