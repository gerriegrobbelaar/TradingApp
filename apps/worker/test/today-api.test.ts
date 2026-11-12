/**
 * The Today queue API (Phase 8, D8c, ADR 0047): merged ranking, deterministic cursor paging,
 * role-dependent actions, snoozed/disabled/skipped issues stay out, no full IBAN, bounded cost
 * (query plans, row caps), read only.
 */
import { env } from "cloudflare:test";
import { amsterdamParts, type TodayResponse } from "@camelthorn/core";
import { beforeEach, describe, expect, it } from "vitest";
import { addSession, addUser, authed, call, resetDb } from "./helpers";
import { db, resetDq } from "./dq-helpers";
import { bookingWorld, seedBookable, type BookingWorld } from "./booking-helpers";
import { addTx } from "./matching-helpers";
import {
  APPROVALS_COUNT_SQL,
  APPROVALS_SQL,
  BOOKING_COUNT_SQL,
  BOOKING_SQL,
  DQ_COUNT_SQL,
  DQ_SQL,
  MATCHES_COUNT_SQL,
  MATCHES_SQL,
  TODAY_SOURCE_CAP,
} from "../src/today/routes";

type Role = "admin" | "finance" | "approver" | "viewer";
const tokens = {} as Record<Role, string>;
let w: BookingWorld;

const get = async (
  role: Role,
  path = "/api/today",
): Promise<{ status: number; body: TodayResponse }> => {
  const res = await authed(path, tokens[role]);
  return { status: res.status, body: (await res.json()) as TodayResponse };
};

const NOW_ISO = (): string => new Date().toISOString();
const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

let n = 0;
async function addEntry(o: {
  status?: string;
  submittedAt?: string | null;
  name?: string;
  divisionId?: number;
}): Promise<number> {
  n += 1;
  const r = await db
    .prepare(
      `INSERT INTO purchase_entries (division_id, exact_id, entry_number, relation_id, relation_name,
         currency, amount_minor, entry_date, status_code, status, submitted_at, modified_at, has_pdf,
         search_text, synced_at, last_seen_sync_id)
       VALUES (?1, ?2, ?3, NULL, ?4, 'EUR', 12345, ?5, 5, ?6, ?7, ?8, 1, 'x', ?8, 3)`,
    )
    .bind(
      o.divisionId ?? w.divisionId,
      `00000000-0000-0000-0000-${String(9000 + n).padStart(12, "0")}`,
      String(80000 + n),
      o.name ?? `Supplier ${n}`,
      amsterdamParts(Date.now()).date,
      o.status ?? "pending_approval",
      o.submittedAt === undefined ? null : o.submittedAt,
      NOW_ISO(),
    )
    .run();
  return r.meta.last_row_id;
}

async function addIssue(o: {
  rule?: string;
  severity?: "info" | "warning" | "critical";
  status?: "open" | "snoozed" | "resolved";
  division?: number;
  message?: string;
  subject?: string;
  firstSeen?: string;
  fix?: string;
  payload?: string;
}): Promise<number> {
  n += 1;
  const status = o.status ?? "open";
  const r = await db
    .prepare(
      `INSERT INTO dq_issues (division_id, rule_id, fingerprint, area, severity, status, subject, message, fix,
         amount_minor, currency, payload_json, first_seen_at, last_seen_at, resolved_at, snoozed_until)
       VALUES (?1, ?2, ?3, 'bank', ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?12, ?9, ?9, ?10, ?11)`,
    )
    .bind(
      o.division ?? w.divisionId,
      o.rule ?? "bank.unmatched_old",
      `${o.rule ?? "bank.unmatched_old"}:${n}`,
      o.severity ?? "warning",
      status,
      o.subject ?? "Line 1",
      o.message ?? "1 bank line is older than 5 days",
      o.fix ?? "bank",
      o.firstSeen ?? daysAgo(2),
      status === "resolved" ? NOW_ISO() : null,
      status === "snoozed" ? new Date(Date.now() + 86_400_000).toISOString() : null,
      o.payload ?? "{}",
    )
    .run();
  return r.meta.last_row_id;
}

async function addOutbox(
  matchId: number,
  status: "manual_required" | "outcome_unknown",
  kind: "bank_entry" | "matchset" = "matchset",
  updatedAt = daysAgo(2),
): Promise<number> {
  await db.prepare("UPDATE matches SET exact_state = 'booking' WHERE id = ?1").bind(matchId).run();
  const r = await db
    .prepare(
      `INSERT INTO exact_write_outbox (match_id, division_id, kind, idempotency_key, payload_json,
         payload_hash, status, claimed_at, lease_expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, '{}', ?4, 'sending', 'x', '2099-01-01T00:00:00.000Z', ?5, ?5)`,
    )
    .bind(matchId, w.divisionId, kind, String(matchId).padStart(64, "c"), updatedAt)
    .run();
  await db
    .prepare("UPDATE exact_write_outbox SET status = ?2 WHERE id = ?1")
    .bind(r.meta.last_row_id, status)
    .run();
  return r.meta.last_row_id;
}

async function suggested(name: string, score: number, createdAt = daysAgo(1)): Promise<number> {
  const id = await addTx({
    accountId: w.accountId,
    connectionId: w.revolutConnectionId,
    amountMinor: 5_000,
    counterpartyName: name,
    matchStatus: "suggested",
    createdAt,
  });
  await db
    .prepare(
      `INSERT INTO match_suggestions (bank_transaction_id, rank, open_item_id, score, rule, kind, allocated_minor,
         computed_at, engine_version, input_hash, ledger_account_code)
       VALUES (?1, 1, NULL, ?2, 2, 'ledger', 5000, ?3, 'v', ?4, '4000')`,
    )
    .bind(id, score, NOW_ISO(), "d".repeat(64))
    .run();
  return id;
}

beforeEach(async () => {
  await resetDb();
  await resetDq();
  w = await bookingWorld();
  for (const role of ["admin", "finance", "approver", "viewer"] as const) {
    tokens[role] = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
  }
});

describe("access", () => {
  it("needs a session and is open to every role", async () => {
    expect((await call("/api/today")).status).toBe(401);
    for (const role of ["admin", "finance", "approver", "viewer"] as const) {
      expect((await get(role)).status, role).toBe(200);
    }
  });

  it("refuses writes and bad parameters", async () => {
    const post = await authed("/api/today", tokens.admin, { method: "POST", json: {} });
    expect([404, 405]).toContain(post.status);
    for (const q of [
      "limit=0",
      "limit=51",
      "limit=x",
      "cursor=zzz",
      "division=abc",
      "division=99999",
    ]) {
      expect((await get("admin", `/api/today?${q}`)).status, q).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("content and ranking", () => {
  it("is empty and honest with nothing to do", async () => {
    const r = await get("viewer");
    expect(r.body.items).toEqual([]);
    expect(r.body.total).toBe(0);
    expect(r.body.nextCursor).toBeNull();
    expect(r.body.capped).toBe(false);
    expect(r.body.approvalMappingVerified).toBe(false);
  });

  it("a suggested bank line older than the limit is listed once, as the match item (V1 N3)", async () => {
    const sug = await suggested("Customer X", 92, daysAgo(9));
    const plain = await addTx({
      accountId: w.accountId,
      connectionId: w.revolutConnectionId,
      amountMinor: 7_000,
      counterpartyName: "Customer Y",
      createdAt: daysAgo(9),
    });
    await addIssue({ payload: JSON.stringify({ days: 9, txId: sug }) });
    const keep = await addIssue({ payload: JSON.stringify({ days: 9, txId: plain }) });
    const ids = (await get("admin")).body.items.map((i) => i.id);
    expect(ids).toContain(`match:${sug}`);
    expect(ids).toContain(`dq:${keep}`);
    expect(ids.filter((id) => id.startsWith("dq:"))).toEqual([`dq:${keep}`]);
  });

  it("a suggested line that is not listed as a match item (still pending) keeps its issue (reviewer, N3)", async () => {
    const sug = await suggested("Customer Z", 90, daysAgo(9));
    await db
      .prepare("UPDATE bank_transactions SET state = 'pending' WHERE id = ?1")
      .bind(sug)
      .run();
    const issue = await addIssue({ payload: JSON.stringify({ days: 9, txId: sug }) });
    const ids = (await get("admin")).body.items.map((i) => i.id);
    expect(ids).not.toContain(`match:${sug}`);
    expect(ids).toContain(`dq:${issue}`);
  });

  it("merges the four sources in priority order", async () => {
    const approvalLate = await addEntry({ submittedAt: daysAgo(6), name: "Late Supplier B.V." });
    const approvalNew = await addEntry({ submittedAt: daysAgo(1) });
    const sug = await suggested("Customer X", 92);
    const crit = await addIssue({
      severity: "critical",
      rule: "payables.supplier_iban_changed",
      fix: "payables",
      message: "1 supplier IBAN changed",
      subject: "Acme",
    });
    const warn = await addIssue({ severity: "warning" });
    const s = await seedBookable(w, null);
    const unknown = await addOutbox(s.matchId, "outcome_unknown");
    const s2 = await seedBookable(w, null);
    const manual = await addOutbox(s2.matchId, "manual_required", "bank_entry");

    const r = (await get("admin")).body;
    expect(r.items.map((i) => i.id)).toEqual([
      `booking:${unknown}`,
      `dq:${crit}`,
      `booking:${manual}`,
      `dq:${warn}`,
      `approval:${approvalLate}`,
      `match:${sug}`,
      `approval:${approvalNew}`,
    ]);
    expect(r.counts).toEqual({ approval: 2, match: 1, booking: 2, dq: 2 });
    expect(r.total).toBe(7);
    const first = r.items[0]!;
    expect(first).toMatchObject({
      kind: "booking",
      severity: "critical",
      priority: 100,
      fix: "booking",
      fixPath: "/settings/matching",
    });
    expect(first.title).toMatch(/^\d+ days?: booking outcome unknown$/);
    const late = r.items.find((i) => i.id === `approval:${approvalLate}`)!;
    expect(late.title).toBe("6 days waiting for approval");
    expect(late.subtitle).toContain("Late Supplier B.V.");
    expect(late).toMatchObject({
      amountMinor: 12_345,
      currency: "EUR",
      fixPath: "/purchases/approvals",
    });
    const m = r.items.find((i) => i.id === `match:${sug}`)!;
    expect(m.title).toBe("92% match suggested");
    expect(m.fixPath).toBe("/treasury/bank?tab=review&queue=suggested");
    expect(m.amountMinor).toBe(5_000);
  });

  it("leaves out snoozed, resolved, info, disabled-rule and duplicated-source issues", async () => {
    await addIssue({ status: "snoozed" });
    await addIssue({ status: "resolved" });
    await addIssue({ severity: "info" });
    await addIssue({ rule: "bank.booking_outcome_unknown", severity: "critical" });
    await addIssue({ rule: "bank.booking_manual_required" });
    await addIssue({ rule: "payables.approvals_overdue" });
    const off = await addIssue({ rule: "bank.duplicate_lines" });
    await db
      .prepare(
        "INSERT INTO dq_rules (id, enabled, rev, updated_by, updated_at) VALUES ('bank.duplicate_lines', 0, 'r', 'a', 'x')",
      )
      .run();
    const keep = await addIssue({ rule: "fx.rate_stale", severity: "warning", division: 0 });
    const r = (await get("viewer")).body;
    expect(r.items.map((i) => i.id)).toEqual([`dq:${keep}`]);
    expect(r.items.map((i) => i.id)).not.toContain(`dq:${off}`);
    expect(r.counts.dq).toBe(1);
  });

  it("shows stale settlements as a booking item that carries its issue", async () => {
    const id = await addIssue({
      rule: "bank.stale_settlements",
      message: "3 settlements still count after 48 hours",
      subject: "Administration 1",
      fix: "booking",
    });
    const admin = (await get("admin")).body.items[0]!;
    expect(admin).toMatchObject({
      kind: "booking",
      id: `booking:stale-${id}`,
      priority: 75,
      issueId: id,
    });
    expect(admin.actions).toEqual(["open", "snooze", "resolve"]);
    const finance = (await get("finance")).body.items[0]!;
    expect(finance.actions).toEqual([]);
  });

  it("gives actions by role", async () => {
    await addEntry({ submittedAt: daysAgo(5) });
    const issue = await addIssue({ severity: "critical" });
    const byRole = async (role: Role) =>
      Object.fromEntries((await get(role)).body.items.map((i) => [i.kind, i.actions]));
    expect(await byRole("viewer")).toEqual({ approval: ["open"], dq: ["open"] });
    expect(await byRole("approver")).toEqual({ approval: ["open"], dq: ["open"] });
    expect(await byRole("finance")).toEqual({
      approval: ["open"],
      dq: ["open", "snooze", "resolve"],
    });
    expect((await get("admin")).body.items.find((i) => i.kind === "dq")?.issueId).toBe(issue);
  });

  it("scopes approvals and booking to the chosen administration, issues to it plus global", async () => {
    const other = (
      await db
        .prepare(
          `INSERT INTO divisions (connection_id, exact_division, name, base_currency, sync_enabled, base_currency_read_at)
           VALUES (?1, 777, 'Other', 'EUR', 1, '2026-01-01T00:00:00.000Z')`,
        )
        .bind(w.exactConnectionId)
        .run()
    ).meta.last_row_id;
    await addEntry({ divisionId: other });
    const mine = await addEntry({});
    const gl = await addIssue({ division: 0, rule: "fx.rate_stale" });
    await addIssue({ division: other });
    const ids = (await get("admin", `/api/today?division=${w.divisionId}`)).body.items.map(
      (i) => i.id,
    );
    expect(ids.sort()).toEqual([`approval:${mine}`, `dq:${gl}`].sort());
  });

  it("works without any administration (bank lines and global issues only)", async () => {
    await db.batch([
      db.prepare("DELETE FROM match_allocations"),
      db.prepare("DELETE FROM matches"),
      db.prepare("DELETE FROM bank_account_exact_map"),
      db.prepare("DELETE FROM relation_bank_accounts"),
      db.prepare("DELETE FROM open_items"),
      db.prepare("DELETE FROM sync_state"),
      db.prepare("DELETE FROM divisions"),
    ]);
    const sug = await suggested("Customer", 80);
    const r = await get("viewer");
    expect(r.status).toBe(200);
    expect(r.body.items.map((i) => i.id)).toEqual([`match:${sug}`]);
  });
});

describe("paging", () => {
  it("pages the same list whatever the page size, with no gaps or repeats", async () => {
    for (let i = 0; i < 9; i++) await addEntry({ submittedAt: daysAgo(i) });
    for (let i = 0; i < 5; i++) await suggested(`Customer ${i}`, 50 + i, daysAgo(i));
    for (let i = 0; i < 4; i++)
      await addIssue({ severity: i % 2 ? "critical" : "warning", firstSeen: daysAgo(i) });
    const all = (await get("admin", "/api/today?limit=50")).body;
    expect(all.items).toHaveLength(18);
    expect(all.nextCursor).toBeNull();
    for (const size of [1, 4, 7]) {
      const got: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 30; guard++) {
        const r: { body: TodayResponse } = await get(
          "admin",
          `/api/today?limit=${size}${cursor ? `&cursor=${cursor}` : ""}`,
        );
        got.push(...r.body.items.map((i) => i.id));
        cursor = r.body.nextCursor;
        if (cursor === null) break;
      }
      expect(got, `size ${size}`).toEqual(all.items.map((i) => i.id));
    }
  });
});

describe("privacy and read only", () => {
  it("never returns a full IBAN, even from a stored message", async () => {
    await addIssue({
      message: "Supplier NL91ABNA0417164300 changed",
      subject: "NL91ABNA0417164300",
      severity: "critical",
    });
    await suggested("Pay NL91 ABNA 0417 1643 00 B.V.", 70);
    const text = JSON.stringify((await get("viewer")).body);
    expect(text).not.toMatch(/NL91ABNA0417164300/);
    expect(text.replace(/\s/g, "")).not.toMatch(/NL91ABNA0417164300/);
  });

  it("writes nothing", async () => {
    await addEntry({});
    await addIssue({});
    const count = async (): Promise<number[]> =>
      Promise.all(
        [
          "audit_log",
          "dq_issues",
          "exact_write_outbox",
          "matches",
          "match_suggestions",
          "settings",
        ].map(
          async (t) =>
            (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? -1,
        ),
      );
    await get("admin"); // the first request of a run seeds the admin marker; not ours
    const before = await count();
    await get("admin");
    expect(await count()).toEqual(before);
  });
});

describe("cost", () => {
  const plan = async (sql: string, ...binds: number[]): Promise<string> =>
    (
      await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...binds)
        .all<{ detail: string }>()
    ).results
      .map((r) => r.detail)
      .join("\n");

  it("uses an index for every query; only the matching rows of a source are sorted", async () => {
    const queries: [string, string, number[]][] = [
      ["approvals", APPROVALS_SQL, [1]],
      ["approvals count", APPROVALS_COUNT_SQL, [1]],
      ["matches", MATCHES_SQL, []],
      ["matches count", MATCHES_COUNT_SQL, []],
      ["booking", BOOKING_SQL, [1]],
      ["booking count", BOOKING_COUNT_SQL, [1]],
      ["dq", DQ_SQL, [1]],
      ["dq count", DQ_COUNT_SQL, [1]],
    ];
    for (const [name, sql, binds] of queries) {
      const p = await plan(sql, ...binds);
      expect(p, name).toMatch(/SEARCH|COVERING INDEX/);
      // A full scan of the big tables would read every row on each visit.
      expect(p, name).not.toMatch(/SCAN (purchase_entries|bank_transactions|dq_issues)\b/);
    }
    expect(await plan(APPROVALS_SQL, 1)).toContain("idx_purchase_entries_list");
    expect(await plan(DQ_SQL, 1)).toContain("idx_dq_issues_list");
  });

  it("reads at most the cap from a source and says so", async () => {
    const stmts = [];
    for (let i = 0; i < TODAY_SOURCE_CAP + 20; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO purchase_entries (division_id, exact_id, entry_number, relation_name, currency, amount_minor,
             entry_date, status_code, status, modified_at, search_text, synced_at, last_seen_sync_id)
           VALUES (?1, ?2, ?3, 'S', 'EUR', 100, '2026-01-01', 5, 'pending_approval', 'x', 'x', 'x', 3)`,
        ).bind(
          w.divisionId,
          `00000000-0000-0000-0000-${String(500000 + i).padStart(12, "0")}`,
          String(i),
        ),
      );
    }
    await env.DB.batch(stmts);
    const r = (await get("admin", "/api/today?limit=50")).body;
    expect(r.capped).toBe(true);
    expect(r.counts.approval).toBe(TODAY_SOURCE_CAP + 20);
    let seen = 0;
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const p: { body: TodayResponse } = await get(
        "admin",
        `/api/today?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
      );
      seen += p.body.items.length;
      cursor = p.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toBe(TODAY_SOURCE_CAP);
    expect(r.cappedKinds).toEqual(["approval"]);
  });

  it("reads a cut source in queue order: the oldest issue is never the one left out", async () => {
    // Inserted first (lowest id) but waiting longest: a list read newest-id-first would drop it.
    const oldest = await addIssue({ firstSeen: daysAgo(30), message: "Oldest" });
    const stmts = [];
    for (let i = 0; i < TODAY_SOURCE_CAP + 5; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO dq_issues (division_id, rule_id, fingerprint, area, severity, status, subject, message, fix,
             payload_json, first_seen_at, last_seen_at)
           VALUES (?1, 'bank.unmatched_old', ?2, 'bank', 'warning', 'open', 's', 'm', 'bank', '{}', ?3, ?3)`,
        ).bind(w.divisionId, `bank.unmatched_old:bulk-${i}`, daysAgo(1)),
      );
    }
    // A stale-settlement issue (priority 75) with an id above all of them still ranks first.
    stmts.push(
      env.DB.prepare(
        `INSERT INTO dq_issues (division_id, rule_id, fingerprint, area, severity, status, subject, message, fix,
           payload_json, first_seen_at, last_seen_at)
         VALUES (?1, 'bank.stale_settlements', 'bank.stale_settlements:division', 'bank', 'warning', 'open',
           'Booking health', '2 booked payments', 'booking', '{}', ?2, ?2)`,
      ).bind(w.divisionId, daysAgo(0)),
    );
    await env.DB.batch(stmts);
    const r = (await get("admin", "/api/today?limit=50")).body;
    expect(r.items[0]?.id).toMatch(/^booking:stale-\d+$/);
    expect(r.items[1]?.id).toBe(`dq:${oldest}`);
    expect(r.capped).toBe(true);
    expect(r.cappedKinds).toEqual(["dq"]);
  });

  it("serves nothing past a cut source's last row, so the queue is a true prefix", async () => {
    const stmts = [];
    for (let i = 0; i < TODAY_SOURCE_CAP + 3; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO dq_issues (division_id, rule_id, fingerprint, area, severity, status, subject, message, fix,
             payload_json, first_seen_at, last_seen_at)
           VALUES (?1, 'bank.unmatched_old', ?2, 'bank', 'warning', 'open', 's', 'm', 'bank', '{}', ?3, ?3)`,
        ).bind(w.divisionId, `bank.unmatched_old:bulk-${i}`, daysAgo(1)),
      );
    }
    await env.DB.batch(stmts);
    // Lower priority than any warning issue: they must wait until the unread warnings are served.
    await addEntry({ submittedAt: daysAgo(6) });
    await suggested("Customer", 90);
    const kinds: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const p: { body: TodayResponse } = await get(
        "admin",
        `/api/today?limit=40${cursor ? `&cursor=${cursor}` : ""}`,
      );
      kinds.push(...p.body.items.map((i) => i.kind));
      cursor = p.body.nextCursor;
      if (cursor === null) break;
    }
    expect(kinds).toHaveLength(TODAY_SOURCE_CAP);
    expect(new Set(kinds)).toEqual(new Set(["dq"]));
    const first = (await get("admin")).body;
    expect(first.counts).toMatchObject({ dq: TODAY_SOURCE_CAP + 3, approval: 1, match: 1 });
    expect(first.cappedKinds).toEqual(["dq"]);
  });
});

describe("honesty and robustness", () => {
  it("says which kinds were not looked at and whether the data checks ran", async () => {
    let r = (await get("viewer")).body;
    expect(r.notChecked).toEqual([]);
    expect(r.dqLastRun).toBeNull();
    expect(r.cappedKinds).toEqual([]);
    await db
      .prepare(
        `INSERT INTO dq_runs (started_at, finished_at, status, engine_version)
         VALUES (?1, ?1, 'error', 'v')`,
      )
      .bind(NOW_ISO())
      .run();
    r = (await get("viewer")).body;
    expect(r.dqLastRun?.status).toBe("error");
    await db.batch([
      db.prepare("DELETE FROM match_allocations"),
      db.prepare("DELETE FROM matches"),
      db.prepare("DELETE FROM bank_account_exact_map"),
      db.prepare("DELETE FROM relation_bank_accounts"),
      db.prepare("DELETE FROM open_items"),
      db.prepare("DELETE FROM sync_state"),
      db.prepare("DELETE FROM divisions"),
    ]);
    r = (await get("viewer")).body;
    expect(r.notChecked).toEqual(["approval", "booking"]);
  });

  it("maps an unknown or prototype fix key to a real path", async () => {
    for (const fix of ["constructor", "toString", "__proto__", "nope"]) {
      await addIssue({ fix, severity: "critical", message: fix });
    }
    const r = (await get("viewer")).body;
    expect(r.items).toHaveLength(4);
    for (const i of r.items) {
      expect(i.fix).toBe("bank");
      expect(i.fixPath).toBe("/treasury/bank");
    }
  });

  it("pages across instants spelled differently and out-of-range years without a bad cursor", async () => {
    await addEntry({ submittedAt: "+010000-01-01T00:00:00.000Z" });
    await addEntry({ submittedAt: daysAgo(2) });
    await suggested("A", 70, "2026-01-05T10:00:00Z");
    await suggested("B", 70, "2026-01-05T10:00:00.000Z");
    const got: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const p: { status: number; body: TodayResponse } = await get(
        "admin",
        `/api/today?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(p.status).toBe(200);
      got.push(...p.body.items.map((i) => i.id));
      for (const i of p.body.items) {
        if (i.since !== null)
          expect(i.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
      cursor = p.body.nextCursor;
      if (cursor === null) break;
    }
    expect(got).toHaveLength(4);
    expect(new Set(got).size).toBe(4);
  });

  it("does not skip or repeat when an item is handled between pages", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(await addIssue({ firstSeen: daysAgo(10 - i) }));
    const p1 = (await get("admin", "/api/today?limit=2")).body;
    expect(p1.items.map((i) => i.id)).toEqual([`dq:${ids[0]}`, `dq:${ids[1]}`]);
    // Someone resolves the first item and the third before page 2 is read.
    await db
      .prepare(
        "UPDATE dq_issues SET status = 'resolved', resolved_at = ?2, resolved_by = 'x' WHERE id IN (?1, ?3)",
      )
      .bind(ids[0], NOW_ISO(), ids[2])
      .run();
    const p2 = (await get("admin", `/api/today?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.items.map((i) => i.id)).toEqual([`dq:${ids[3]}`, `dq:${ids[4]}`]);
  });
});
