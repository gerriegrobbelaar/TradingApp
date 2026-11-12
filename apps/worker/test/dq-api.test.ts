/**
 * The data quality API (ADR 0045): access rules, summary, issue list, snooze and resolve (audited,
 * idempotent), rule overrides (admin, step-up, typed phrase for loosening a critical rule).
 */
import {
  DQ_LOOSEN_PHRASE,
  DQ_RULES,
  type DqIssueDto,
  type DqIssuesResponse,
  type DqRulesResponse,
  type DqSummaryResponse,
} from "@camelthorn/core";
import { beforeEach, describe, expect, it } from "vitest";
import { addSession, addUser, authed, call, resetDb } from "./helpers";
import { db, issues, resetDq, runDq } from "./dq-helpers";
import { addItem, addRelation, addTx, resetWorld, type World } from "./matching-helpers";
import { auditRows } from "./sync-helpers";

type Role = "admin" | "finance" | "approver" | "viewer" | "staleAdmin";
const tokens = {} as Record<Role, string>;
let w: World;
const DAY = 86_400_000;

async function send<T = Record<string, unknown>>(
  role: Role,
  method: string,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await authed(path, tokens[role], { method, ...(json !== undefined ? { json } : {}) });
  return { status: res.status, body: (await res.json()) as T };
}
const get = <T>(role: Role, path: string) => send<T>(role, "GET", path);
const err = (r: { body: unknown }): unknown => (r.body as { error?: unknown }).error;

/** Issues from a real run on the real clock's neighbourhood (rows booked 14 days before NOW). */
async function seed(): Promise<void> {
  const rel = await addRelation({
    divisionId: w.divisionId,
    ibans: [],
    ibanChangedAt: "2026-07-10T00:00:00.000Z",
  });
  for (let i = 0; i < 2; i++) {
    await addItem({
      divisionId: w.divisionId,
      kind: "bill",
      invoiceNumber: "F-1",
      openMinor: 10_000,
      relationExactId: rel.exactId,
      relationName: "Acme B.V.",
    });
  }
  for (let i = 0; i < 3; i++) {
    await addTx({
      accountId: w.accountId,
      connectionId: w.revolutConnectionId,
      amountMinor: -(100 + i),
      createdAt: `2026-07-0${i + 1}T08:00:00.000Z`,
      counterpartyName: `Supplier ${i}`,
    });
  }
  await runDq();
}

beforeEach(async () => {
  await resetDb();
  await resetDq();
  w = await resetWorld();
  for (const role of ["admin", "finance", "approver", "viewer"] as const) {
    tokens[role] = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
  }
  tokens.staleAdmin = await addSession(await addUser("stale@camelthorncapital.com", ["admin"]), {
    lastAuthAgoMs: 20 * 60_000,
  });
});

describe("access rules", () => {
  it("needs a session", async () => {
    for (const p of ["/api/dq/summary", "/api/dq/issues", "/api/dq/rules"]) {
      expect((await call(p)).status, p).toBe(401);
    }
  });

  it("reads: every role for summary and issues, admin only for rules", async () => {
    for (const role of ["admin", "finance", "approver", "viewer"] as const) {
      expect((await get(role, "/api/dq/summary")).status, role).toBe(200);
      expect((await get(role, "/api/dq/issues")).status, role).toBe(200);
      expect((await get(role, "/api/dq/rules")).status, role).toBe(role === "admin" ? 200 : 403);
    }
  });

  it("writes: finance and admin may snooze and resolve; approver and viewer may not", async () => {
    await seed();
    const id = (await issues())[0]?.id as number;
    for (const role of ["approver", "viewer"] as const) {
      expect(
        (await send(role, "POST", `/api/dq/issues/${id}/snooze`, { until: "x", note: "n" })).status,
      ).toBe(403);
      expect(
        (await send(role, "POST", `/api/dq/issues/${id}/resolve-note`, { note: "n" })).status,
      ).toBe(403);
      expect(
        (
          await send(role, "PATCH", "/api/dq/rules/bank.unmatched_old", {
            rev: null,
            enabled: false,
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await send("finance", "PATCH", "/api/dq/rules/bank.unmatched_old", {
          rev: null,
          enabled: false,
        })
      ).status,
    ).toBe(403);
  });

  it("an unsafe request without the CSRF header is refused", async () => {
    await seed();
    const id = (await issues())[0]?.id as number;
    const res = await call(`/api/dq/issues/${id}/resolve-note`, {
      method: "POST",
      headers: { cookie: `__Host-session=${tokens.finance}`, "content-type": "application/json" },
      body: JSON.stringify({ note: "n" }),
    });
    expect(res.status).toBe(403);
    expect((await issues(`id = ${id}`))[0]?.status).toBe("open");
  });

  it("changing a rule needs a fresh sign-in", async () => {
    const r = await send("staleAdmin", "PATCH", "/api/dq/rules/bank.unmatched_old", {
      rev: null,
      enabled: false,
    });
    expect(r.status).toBe(401);
    expect(err(r)).toBe("step_up_required");
  });
});

describe("GET /api/dq/summary", () => {
  it("counts open issues by severity and area and lists every rule with its status and reason", async () => {
    await seed();
    const { body } = await get<DqSummaryResponse>("viewer", "/api/dq/summary");
    expect(body.divisionId).toBe(w.divisionId);
    expect(body.lastRun).toMatchObject({ status: "ok", divisions: 1 });
    const total = body.open.info + body.open.warning + body.open.critical;
    expect(total).toBe((await issues("status = 'open'")).length);
    expect(body.open.critical).toBeGreaterThan(0); // supplier IBAN changed
    expect(body.byArea.bank.warning).toBe(3);
    expect(body.rules).toHaveLength(DQ_RULES.length);
    const by = (id: string) => body.rules.find((r) => r.ruleId === id);
    expect(by("bank.unmatched_old")).toMatchObject({
      status: "issues",
      openIssues: 3,
      enabled: true,
    });
    expect(by("receivables.bounced_emails")).toMatchObject({
      status: "not_available",
      reason: "email_log_empty_until_phase_10",
    });
    expect(by("ledger.suspense_not_zero")).toMatchObject({ status: "not_configured" });
    expect(by("bank.balance_mismatch")?.status).toBe("not_available");
    // no rule that was not evaluated claims ok
    for (const r of body.rules) {
      if (r.reason !== null && r.status !== "never_run") {
        expect(["not_available", "not_configured", "disabled", "error"]).toContain(r.status);
      }
    }
  });

  it("before the first run every rule is never_run and the last run is null", async () => {
    const { body } = await get<DqSummaryResponse>("viewer", "/api/dq/summary");
    expect(body.lastRun).toBeNull();
    expect(body.rules.every((r) => r.status === "never_run")).toBe(true);
    expect(body.open).toEqual({ info: 0, warning: 0, critical: 0 });
  });

  it("a disabled rule shows as disabled and its issues leave the counts", async () => {
    await seed();
    await send("admin", "PATCH", "/api/dq/rules/bank.unmatched_old", { rev: null, enabled: false });
    const { body } = await get<DqSummaryResponse>("viewer", "/api/dq/summary");
    expect(body.rules.find((r) => r.ruleId === "bank.unmatched_old")).toMatchObject({
      status: "disabled",
      reason: "rule_disabled",
      enabled: false,
      openIssues: 0,
    });
    expect(body.byArea.bank.warning).toBe(0);
    const list = await get<DqIssuesResponse>("viewer", "/api/dq/issues?rule=bank.unmatched_old");
    expect(list.body.issues).toEqual([]);
  });

  it("unknown division is 404", async () => {
    expect((await get("viewer", "/api/dq/summary?division=99999")).status).toBe(404);
    expect((await get("viewer", "/api/dq/summary?division=abc")).status).toBe(400);
  });
});

describe("GET /api/dq/issues", () => {
  it("lists critical first, filters, and pages with a cursor", async () => {
    await seed();
    const all = (await get<DqIssuesResponse>("viewer", "/api/dq/issues?limit=100")).body.issues;
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all[0]?.severity).toBe("critical");
    const ranks = all.map((i) => ["info", "warning", "critical"].indexOf(i.severity));
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    for (const i of all) {
      expect(i.fixPath).toMatch(/^\//);
      expect(i.divisionId === w.divisionId || i.divisionId === 0).toBe(true);
    }

    const page1 = (await get<DqIssuesResponse>("viewer", "/api/dq/issues?limit=2")).body;
    expect(page1.issues).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const seen = [...page1.issues];
    let cursor = page1.nextCursor;
    while (cursor !== null) {
      const next = (
        await get<DqIssuesResponse>("viewer", `/api/dq/issues?limit=2&cursor=${cursor}`)
      ).body;
      seen.push(...next.issues);
      cursor = next.nextCursor;
    }
    expect(seen.map((i) => i.id)).toEqual(all.map((i) => i.id));

    const bank = (await get<DqIssuesResponse>("viewer", "/api/dq/issues?area=bank")).body.issues;
    expect(bank.length).toBe(3);
    expect(bank.every((i) => i.area === "bank")).toBe(true);
    const crit = (await get<DqIssuesResponse>("viewer", "/api/dq/issues?severity=critical")).body
      .issues;
    expect(crit.every((i) => i.severity === "critical")).toBe(true);
    const rule = (await get<DqIssuesResponse>("viewer", "/api/dq/issues?rule=bank.unmatched_old"))
      .body.issues;
    expect(rule).toHaveLength(3);
  });

  it("rejects bad filters", async () => {
    for (const q of [
      "status=nope",
      "area=nope",
      "severity=nope",
      "rule=nope.nope",
      "limit=0",
      "limit=101",
      "limit=x",
      "cursor=junk",
      "cursor=9:1",
    ]) {
      const r = await get("viewer", `/api/dq/issues?${q}`);
      expect(r.status, q).toBe(400);
    }
  });

  it("status filter: resolved and snoozed are listed only when asked for", async () => {
    await seed();
    const id = (await issues("rule_id = 'bank.unmatched_old'"))[0]?.id as number;
    await send("finance", "POST", `/api/dq/issues/${id}/resolve-note`, { note: "done" });
    const open = (await get<DqIssuesResponse>("viewer", "/api/dq/issues?rule=bank.unmatched_old"))
      .body.issues;
    expect(open.map((i) => i.id)).not.toContain(id);
    const resolved = (await get<DqIssuesResponse>("viewer", "/api/dq/issues?status=resolved")).body
      .issues;
    expect(resolved.map((i) => i.id)).toEqual([id]);
    const everything = (
      await get<DqIssuesResponse>("viewer", "/api/dq/issues?status=all&limit=100")
    ).body.issues;
    expect(everything.map((i) => i.id)).toContain(id);
  });

  it("never returns a full IBAN, whatever is stored", async () => {
    await seed();
    await db
      .prepare(
        "UPDATE dq_issues SET subject = ?1, message = ?2 WHERE id = (SELECT MIN(id) FROM dq_issues)",
      )
      .bind("Pay NL91ABNA0417164300", "from NL91 ABNA 0417 1643 00")
      .run();
    const text = JSON.stringify((await get("viewer", "/api/dq/issues?limit=100")).body);
    expect(text).not.toContain("0417164300");
    expect(text).not.toContain("0417 1643");
    expect(text).toContain("NL91****4300");
  });
});

describe("POST /api/dq/issues/:id/snooze", () => {
  const until = (days: number) => new Date(Date.now() + days * DAY).toISOString();

  it("snoozes an open issue, audits it once, and an identical repeat is a quiet success", async () => {
    await seed();
    const id = (await issues("status = 'open'"))[0]?.id as number;
    const u = until(3);
    const r = await send<{ issue: DqIssueDto }>("finance", "POST", `/api/dq/issues/${id}/snooze`, {
      until: u,
      note: "waiting for the bank",
    });
    expect(r.status).toBe(200);
    expect(r.body.issue).toMatchObject({
      status: "snoozed",
      snoozedUntil: u,
      snoozedBy: "finance@camelthorncapital.com",
      snoozeNote: "waiting for the bank",
    });
    const again = await send<{ issue: DqIssueDto }>(
      "finance",
      "POST",
      `/api/dq/issues/${id}/snooze`,
      { until: u, note: "waiting for the bank" },
    );
    expect(again.status).toBe(200);
    expect(await auditRows("dq.issue_snoozed", id)).toHaveLength(1);
    // another person, or another date, is a conflict
    const other = await send("admin", "POST", `/api/dq/issues/${id}/snooze`, {
      until: u,
      note: "x",
    });
    expect(other.status).toBe(409);
    expect(err(other)).toBe("not_open");
    // snoozed issues leave the open list and show up under snoozed
    expect((await get<DqSummaryResponse>("viewer", "/api/dq/summary")).body.snoozed).toBe(1);
    const sn = (await get<DqIssuesResponse>("viewer", "/api/dq/issues?status=snoozed")).body.issues;
    expect(sn.map((i) => i.id)).toEqual([id]);
  });

  it("validates the date, the note and the id", async () => {
    await seed();
    const id = (await issues("status = 'open'"))[0]?.id as number;
    const bad = async (body: unknown, code: string) => {
      const r = await send("finance", "POST", `/api/dq/issues/${id}/snooze`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(err(r)).toBe(code);
    };
    await bad({ until: "not a date", note: "n" }, "bad_until");
    await bad({ until: 5, note: "n" }, "bad_until");
    await bad({ until: new Date(Date.now() - DAY).toISOString(), note: "n" }, "until_in_past");
    await bad({ until: until(91), note: "n" }, "until_too_far");
    await bad({ until: until(2) }, "bad_note");
    await bad({ until: until(2), note: "" }, "bad_note");
    await bad({ until: until(2), note: "x".repeat(201) }, "bad_note");
    await bad({ until: until(2), note: "a\u202eb" }, "bad_note");
    await bad({ until: until(2), note: "n", extra: 1 }, "bad_request");
    expect(
      (
        await send("finance", "POST", "/api/dq/issues/999999/snooze", {
          until: until(2),
          note: "n",
        })
      ).status,
    ).toBe(404);
    expect(
      (await send("finance", "POST", "/api/dq/issues/abc/snooze", { until: until(2), note: "n" }))
        .status,
    ).toBe(404);
    expect((await issues(`id = ${id}`))[0]?.status).toBe("open");
    expect(
      (
        await send("finance", "POST", `/api/dq/issues/${id}/snooze`, {
          until: until(90),
          note: "limit",
        })
      ).status,
    ).toBe(200);
  });
});

describe("POST /api/dq/issues/:id/resolve-note", () => {
  it("resolves with a note, audits once, replays quietly, and refuses a different second resolver", async () => {
    await seed();
    const id = (await issues("status = 'open'"))[0]?.id as number;
    const r = await send<{ issue: DqIssueDto }>(
      "finance",
      "POST",
      `/api/dq/issues/${id}/resolve-note`,
      { note: "fixed in Exact" },
    );
    expect(r.status).toBe(200);
    expect(r.body.issue).toMatchObject({
      status: "resolved",
      resolvedBy: "finance@camelthorncapital.com",
      resolutionNote: "fixed in Exact",
    });
    expect(r.body.issue.resolvedAt).not.toBeNull();
    expect(
      (
        await send("finance", "POST", `/api/dq/issues/${id}/resolve-note`, {
          note: "fixed in Exact",
        })
      ).status,
    ).toBe(200);
    expect(await auditRows("dq.issue_resolved", id)).toHaveLength(1);
    const other = await send("admin", "POST", `/api/dq/issues/${id}/resolve-note`, {
      note: "me too",
    });
    expect(other.status).toBe(409);
    expect(err(other)).toBe("already_resolved");
  });

  it("resolves a snoozed issue and clears the snooze", async () => {
    await seed();
    const id = (await issues("status = 'open'"))[0]?.id as number;
    await send("finance", "POST", `/api/dq/issues/${id}/snooze`, {
      until: new Date(Date.now() + 2 * DAY).toISOString(),
      note: "wait",
    });
    const r = await send<{ issue: DqIssueDto }>(
      "finance",
      "POST",
      `/api/dq/issues/${id}/resolve-note`,
      { note: "done" },
    );
    expect(r.body.issue).toMatchObject({
      status: "resolved",
      snoozedUntil: null,
      snoozedBy: null,
      snoozeNote: null,
    });
  });

  it("needs a note and a known issue", async () => {
    await seed();
    const id = (await issues("status = 'open'"))[0]?.id as number;
    expect(err(await send("finance", "POST", `/api/dq/issues/${id}/resolve-note`, {}))).toBe(
      "bad_note",
    );
    expect(
      (await send("finance", "POST", "/api/dq/issues/999999/resolve-note", { note: "n" })).status,
    ).toBe(404);
  });
});

describe("rules: GET and PATCH", () => {
  const ID = "bank.unmatched_old";

  it("lists every rule with its default, spec and phrase", async () => {
    const { body } = await get<DqRulesResponse>("admin", "/api/dq/rules");
    expect(body.rules).toHaveLength(DQ_RULES.length);
    expect(body.loosenPhrase).toBe(DQ_LOOSEN_PHRASE);
    const r = body.rules.find((x) => x.id === ID);
    expect(r).toMatchObject({
      severity: "warning",
      enabled: true,
      threshold: 5,
      isOverridden: false,
      rev: null,
    });
    expect(r?.thresholdSpec).toMatchObject({ kind: "number", unit: "days", min: 1, max: 365 });
    expect(body.rules.find((x) => x.id === "ledger.suspense_not_zero")?.threshold).toEqual([]);
  });

  it("changes a threshold and a severity, audits before and after, and moves the rev", async () => {
    const audited = (await auditRows("dq.rule_changed", ID)).length; // the audit log is append-only
    const r = await send<{
      rule: { threshold: number; severity: string; rev: string; isOverridden: boolean };
    }>("admin", "PATCH", `/api/dq/rules/${ID}`, { rev: null, threshold: 7, severity: "critical" });
    expect(r.status).toBe(200);
    expect(r.body.rule).toMatchObject({ threshold: 7, severity: "critical", isOverridden: true });
    const all = await auditRows("dq.rule_changed", ID);
    expect(all).toHaveLength(audited + 1);
    const rows = all.slice(audited);
    expect(JSON.parse(rows[0]?.before_json ?? "{}")).toMatchObject({
      severity: "warning",
      threshold: 5,
    });
    expect(JSON.parse(rows[0]?.after_json ?? "{}")).toMatchObject({
      severity: "critical",
      threshold: 7,
    });
    // the stored rev is required for the next change
    const stale = await send("admin", "PATCH", `/api/dq/rules/${ID}`, { rev: null, threshold: 9 });
    expect(stale.status).toBe(409);
    expect(err(stale)).toBe("conflict");
    const next = await send("admin", "PATCH", `/api/dq/rules/${ID}`, {
      rev: r.body.rule.rev,
      threshold: 6, // tighter (the rule is critical now: a looser value would need the phrase)
    });
    expect(next.status).toBe(200);
    expect(await auditRows("dq.rule_changed", ID)).toHaveLength(audited + 2);
  });

  it("a change that changes nothing writes no audit row", async () => {
    const audited = (await auditRows("dq.rule_changed", ID)).length;
    const r = await send("admin", "PATCH", `/api/dq/rules/${ID}`, {
      rev: null,
      threshold: 5,
      enabled: true,
    });
    expect(r.status).toBe(200);
    expect(await auditRows("dq.rule_changed", ID)).toHaveLength(audited);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM dq_rules").first<{ n: number }>())?.n).toBe(
      0,
    );
  });

  it("loosening a CRITICAL rule needs the typed phrase; tightening does not; a warning rule never does", async () => {
    const crit = "integrations.exact_connection"; // critical, days
    for (const body of [
      { rev: null, enabled: false },
      { rev: null, severity: "warning" },
      // "expires within N days": a SHORTER lead time warns later, so it is the looser change
      { rev: null, threshold: 3 },
    ]) {
      const r = await send("admin", "PATCH", `/api/dq/rules/${crit}`, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(err(r)).toBe("confirmation_required");
    }
    const wrong = await send("admin", "PATCH", `/api/dq/rules/${crit}`, {
      rev: null,
      enabled: false,
      confirm: "loosen critical data quality rule",
    });
    expect(wrong.status).toBe(422);
    const ok = await send<{ rule: { enabled: boolean; rev: string } }>(
      "admin",
      "PATCH",
      `/api/dq/rules/${crit}`,
      { rev: null, enabled: false, confirm: DQ_LOOSEN_PHRASE },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.rule.enabled).toBe(false);
    // tightening (switching on again; for this rule a LONGER lead time is tighter, review D8a)
    const tighter = await send("admin", "PATCH", `/api/dq/rules/${crit}`, {
      rev: ok.body.rule.rev,
      enabled: true,
    });
    expect(tighter.status).toBe(200);
    // a warning rule can be loosened without the phrase
    expect(
      (await send("admin", "PATCH", `/api/dq/rules/${ID}`, { rev: null, enabled: false })).status,
    ).toBe(200);
    // the exact-budget floor goes the other way: LOWER is looser (a warning rule here, so no phrase)
    expect(
      (
        await send("admin", "PATCH", "/api/dq/rules/integrations.exact_budget", {
          rev: null,
          threshold: 100,
        })
      ).status,
    ).toBe(200);
  });

  it("validates input", async () => {
    const bad = async (path: string, body: unknown, code: string, status = 400) => {
      const r = await send("admin", "PATCH", path, body);
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(status);
      expect(err(r)).toBe(code);
    };
    await bad(`/api/dq/rules/${ID}`, { threshold: 7 }, "bad_rev");
    await bad(`/api/dq/rules/${ID}`, { rev: 3, threshold: 7 }, "bad_rev");
    await bad(`/api/dq/rules/${ID}`, { rev: null }, "nothing_to_change");
    await bad(`/api/dq/rules/${ID}`, { rev: null, threshold: 0 }, "bad_threshold");
    await bad(`/api/dq/rules/${ID}`, { rev: null, threshold: 1.5 }, "bad_threshold");
    await bad(`/api/dq/rules/${ID}`, { rev: null, threshold: "5" }, "bad_threshold");
    await bad(`/api/dq/rules/${ID}`, { rev: null, threshold: null }, "bad_threshold");
    await bad(`/api/dq/rules/${ID}`, { rev: null, severity: "urgent" }, "bad_severity");
    await bad(`/api/dq/rules/${ID}`, { rev: null, enabled: "yes" }, "bad_enabled");
    await bad(`/api/dq/rules/${ID}`, { rev: null, confirm: 5, enabled: false }, "bad_request");
    await bad(`/api/dq/rules/${ID}`, { rev: null, other: 1 }, "bad_request");
    await bad("/api/dq/rules/no.such", { rev: null, enabled: false }, "not_found", 404);
    await bad("/api/dq/rules/bank.duplicate_lines", { rev: null, threshold: 3 }, "bad_threshold");
  });

  it("the suspense account list is a list of codes", async () => {
    const id = "ledger.suspense_not_zero";
    expect(
      (
        await send("admin", "PATCH", `/api/dq/rules/${id}`, {
          rev: null,
          threshold: ["1999", "2.5"],
        })
      ).status,
    ).toBe(200);
    const r = await get<DqRulesResponse>("admin", "/api/dq/rules");
    expect(r.body.rules.find((x) => x.id === id)?.threshold).toEqual(["1999", "2.5"]);
    const rev = r.body.rules.find((x) => x.id === id)?.rev ?? null;
    for (const t of [["a b"], ["1", "1"], "1999", [5]]) {
      expect(
        (await send("admin", "PATCH", `/api/dq/rules/${id}`, { rev, threshold: t })).status,
      ).toBe(400);
    }
    // removing a code is loosening, but this rule is not critical: allowed
    expect(
      (await send("admin", "PATCH", `/api/dq/rules/${id}`, { rev, threshold: ["1999"] })).status,
    ).toBe(200);
  });
});
