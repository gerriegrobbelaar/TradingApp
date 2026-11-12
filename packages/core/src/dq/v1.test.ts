/**
 * Phase 8 final-review fixes (V1), pure parts: job_stale counts scheduled slots (weekends, TARGET
 * holidays, last working day) and ignores deliberate skips; source reasons replace "not loaded";
 * the digest leads with the state of the checks; the sender address check; alert keys.
 */
import { describe, expect, it } from "vitest";
import {
  alertKey,
  dqRuleById,
  emptyDigest,
  emptyInput,
  evaluateRules,
  legacyAlertKey,
  normalizeFromAddress,
  renderDigest,
  resolveRuleConfig,
  type DqInput,
  type DqJobIn,
  type DqRuleDef,
} from "./index";
import { slotsPassed } from "./rules-system";

const at = (iso: string): number => Date.parse(iso);
const ECB = { kind: "cron", expr: "15 16 * * *", workingDaysOnly: true } as const;

function jobStale(nowMs: number, job: Partial<DqJobIn>, threshold?: number) {
  const rule = dqRuleById("integrations.job_stale") as DqRuleDef;
  const config = resolveRuleConfig(rule, threshold === undefined ? undefined : { threshold });
  const full: DqJobIn = {
    name: "ecb.fx_import",
    title: "ECB import",
    enabled: true,
    implemented: true,
    schedule: ECB,
    intervalMs: 86_400_000,
    lastSuccessAt: null,
    referenceAt: null,
    lastStatus: "ok",
    lastCode: null,
    ...job,
  };
  return rule.evaluate({ ...emptyInput(nowMs, 0), jobs: [full] }, config);
}

describe("job_stale counts scheduled slots (S2)", () => {
  // Amsterdam is UTC+2 in summer: the 16:15 import is 14:15Z.
  const friday = "2026-07-10T14:16:00.000Z";

  it("a Friday import is not stale over the weekend or on Monday", () => {
    for (const now of [
      "2026-07-11T12:00:00.000Z", // Saturday
      "2026-07-12T20:00:00.000Z", // Sunday
      "2026-07-13T10:00:00.000Z", // Monday morning, before the 16:15 slot
      "2026-07-13T15:00:00.000Z", // Monday 17:00, the Monday slot is the first missed one
    ]) {
      expect(jobStale(at(now), { lastSuccessAt: friday }).status, now).toBe("ok");
    }
  });

  it("two missed working-day slots in a row make it stale", () => {
    const o = jobStale(at("2026-07-14T15:00:00.000Z"), { lastSuccessAt: friday });
    expect(o.status).toBe("issues");
    expect(o.issues[0]?.details).toMatchObject({ job: "ecb.fx_import", neverSucceeded: false });
  });

  it("TARGET holidays do not count (Easter 2026: Good Friday 3 April, Easter Monday 6 April)", () => {
    const thursday = "2026-04-02T14:16:00.000Z";
    expect(jobStale(at("2026-04-07T12:00:00.000Z"), { lastSuccessAt: thursday }).status).toBe("ok");
    // Tuesday's own slot missed: one. Wednesday's missed too: stale.
    expect(jobStale(at("2026-04-07T15:00:00.000Z"), { lastSuccessAt: thursday }).status).toBe("ok");
    expect(jobStale(at("2026-04-08T15:00:00.000Z"), { lastSuccessAt: thursday }).status).toBe(
      "issues",
    );
  });

  it("a last-working-day job is judged by months, not by a 30 day guess", () => {
    const schedule = { kind: "last_working_day", time: "16:30" } as const;
    const ok = at("2026-06-30T14:31:00.000Z");
    const base = {
      schedule,
      intervalMs: 30 * 86_400_000,
      lastSuccessAt: new Date(ok).toISOString(),
    };
    expect(jobStale(at("2026-07-20T10:00:00.000Z"), base).status).toBe("ok");
    expect(jobStale(at("2026-08-05T10:00:00.000Z"), base).status).toBe("ok"); // July slot missed: one
    expect(jobStale(at("2026-09-05T10:00:00.000Z"), base).status).toBe("issues"); // July and August
  });

  it("an hourly job is stale after two missed slots, as before", () => {
    const hourly = { kind: "cron", expr: "20 * * * *" } as const;
    const base = { schedule: hourly, intervalMs: 3_600_000 };
    const last = "2026-07-15T08:21:00.000Z";
    expect(jobStale(at("2026-07-15T09:30:00.000Z"), { ...base, lastSuccessAt: last }).status).toBe(
      "ok",
    );
    // 10:21: the 10:20 run may still be going, so only the 09:20 slot counts as missed (grace).
    expect(jobStale(at("2026-07-15T10:21:00.000Z"), { ...base, lastSuccessAt: last }).status).toBe(
      "ok",
    );
    expect(jobStale(at("2026-07-15T10:36:00.000Z"), { ...base, lastSuccessAt: last }).status).toBe(
      "issues",
    );
  });

  it("one failure plus a run in progress is not two missed slots (grace)", () => {
    const every10 = { kind: "cron", expr: "*/10 * * * *" } as const;
    const base = {
      schedule: every10,
      intervalMs: 600_000,
      lastSuccessAt: "2026-07-15T08:00:30.000Z",
    };
    // 08:10 failed, the 08:20 run is still going at 08:20:40.
    expect(jobStale(at("2026-07-15T08:20:40.000Z"), base).status).toBe("ok");
    // 08:20 failed too: two missed slots once the grace of the second has passed.
    expect(jobStale(at("2026-07-15T08:35:01.000Z"), base).status).toBe("issues");
  });

  it("the slot walk is bounded by the limit and handles the DST change days", () => {
    const hourly = { kind: "cron", expr: "0 * * * *" } as const;
    // Autumn 2026: 25 October, 03:00 CEST -> 02:00 CET, the 02:00 hour fires twice.
    const since = at("2026-10-24T23:30:00.000Z"); // 01:30 CEST
    const now = at("2026-10-25T03:30:00.000Z"); // 04:30 CET: 4 real hours later
    expect(slotsPassed(hourly, since, now, 20)).toBe(4);
    // Spring 2026: 29 March, 02:00 CET -> 03:00 CEST, no 02:00 hour.
    expect(
      slotsPassed(hourly, at("2026-03-29T00:30:00.000Z"), at("2026-03-29T03:30:00.000Z"), 20),
    ).toBe(3);
    // A restricted hour inside the gap fires once, at 03:00 local.
    const daily0230 = { kind: "cron", expr: "30 2 * * *" } as const;
    expect(
      slotsPassed(daily0230, at("2026-03-28T12:00:00.000Z"), at("2026-03-30T12:00:00.000Z"), 20),
    ).toBe(2);
    // The limit bounds the walk even for a schedule that fires every minute for a year.
    expect(
      slotsPassed(
        { kind: "cron", expr: "* * * * *" },
        at("2025-07-15T00:00:00Z"),
        at("2026-07-15T00:00:00Z"),
        20,
      ),
    ).toBe(20);
    // A schedule that cannot be read is null, never a loop.
    expect(slotsPassed({ kind: "cron", expr: "61 * * * *" }, since, now, 20)).toBeNull();
    expect(slotsPassed({ kind: "last_working_day", time: "25:00" }, since, now, 20)).toBeNull();
  });

  it("never succeeded: counts from the reference time; unreadable schedule is unjudged", () => {
    const o = jobStale(at("2026-07-15T10:00:00.000Z"), {
      referenceAt: "2026-07-01T00:00:00.000Z",
    });
    expect(o.status).toBe("issues");
    expect(o.issues[0]?.details).toMatchObject({ neverSucceeded: true });
    const bad = jobStale(at("2026-07-15T10:00:00.000Z"), {
      schedule: { kind: "cron", expr: "nonsense" },
      lastSuccessAt: "2026-07-01T00:00:00.000Z",
    });
    expect(bad.status).toBe("ok");
    expect(bad.unjudged).toHaveLength(1);
  });

  it("slotsPassed stops at the limit", () => {
    expect(
      slotsPassed(
        { kind: "cron", expr: "* * * * *" },
        at("2026-07-15T10:00:00Z"),
        at("2026-07-16T10:00:00Z"),
        5,
      ),
    ).toBe(5);
  });
});

describe("job_stale ignores deliberate skips (S1)", () => {
  const old = { lastSuccessAt: null, referenceAt: "2026-06-01T00:00:00.000Z" };
  const now = at("2026-07-15T10:00:00.000Z");
  it("no e-mail provider, notifications off, no recipients: not judged", () => {
    for (const lastCode of ["email_not_configured", "notifications_disabled", "no_recipients"]) {
      const o = jobStale(now, { ...old, lastStatus: "skipped", lastCode });
      expect(o.status, lastCode).toBe("ok");
      expect(o.checked).toBe(0);
    }
  });
  it("another skip code, or an error with the same code, is still judged", () => {
    expect(jobStale(now, { ...old, lastStatus: "skipped", lastCode: "other" }).status).toBe(
      "issues",
    );
    expect(
      jobStale(now, { ...old, lastStatus: "error", lastCode: "email_not_configured" }).status,
    ).toBe("issues");
  });
});

describe("source reasons (S5)", () => {
  const results = (input: Partial<DqInput>) =>
    evaluateRules({ ...emptyInput(at("2026-07-15T10:00:00Z"), 1), ...input }, "division");

  it("a section left out because its source is not synchronised names the reason", () => {
    const out = results({
      sourceReasons: { openItems: "source_stale", relations: "source_never_synced" },
    });
    const by = (id: string) => out.find((r) => r.ruleId === id);
    expect(by("payables.duplicate_invoices")).toMatchObject({
      status: "not_available",
      reason: "source_stale",
    });
    expect(by("master.supplier_no_iban")).toMatchObject({
      status: "not_available",
      reason: "source_never_synced",
    });
    // A section without a source reason keeps the old reason.
    expect(by("bank.unmatched_old")).toMatchObject({
      status: "not_available",
      reason: "bank_transactions_not_loaded",
    });
  });

  it("never turns into ok", () => {
    const out = results({ sourceReasons: { bankTransactions: "source_stale" } });
    expect(out.find((r) => r.ruleId === "bank.unmatched_old")?.status).toBe("not_available");
  });
});

describe("digest leads with the state of the checks (S4)", () => {
  const base = emptyDigest("2026-07-15");
  it("names a source that is not synchronised in words, escaped in HTML", () => {
    const m = renderDigest(
      {
        ...base,
        checks: { lastRunAt: "2026-07-15T07:20:00.000Z", lastStatus: "ok", stale: false },
        notEvaluated: [
          { ruleTitle: "Duplicate <supplier> invoices", reason: "source_stale" },
          { ruleTitle: "Supplier without bank account", reason: "source_never_synced" },
          { ruleTitle: "Other", reason: "fx_not_loaded" },
        ],
      },
      "",
    );
    expect(m.text).toContain("The last complete read from Exact or Revolut is too old");
    expect(m.text).toContain("The data has never been fully read from Exact or Revolut");
    expect(m.text).toContain("Fx not loaded");
    expect(m.html).toContain("Duplicate &lt;supplier&gt; invoices");
    expect(m.html).not.toContain("<supplier>");
  });
  it("never run", () => {
    const m = renderDigest(
      { ...base, checks: { lastRunAt: null, lastStatus: null, stale: true } },
      "",
    );
    expect(m.subject).toBe("Data quality checks have never run");
    expect(m.text).not.toMatch(/\b0 open/);
    expect(m.html).toContain("have never run");
  });
  it("stale", () => {
    const m = renderDigest(
      {
        ...base,
        checks: { lastRunAt: "2026-07-10T08:20:00.000Z", lastStatus: "ok", stale: true },
        bySeverity: { critical: 1, warning: 2, info: 0 },
      },
      "",
    );
    expect(m.subject).toBe("Data quality checks have not run since 2026-07-10");
    expect(m.text).toContain("1 critical, 2 warning, 0 info");
  });
  it("healthy: the count first, the scope stated", () => {
    const m = renderDigest(
      {
        ...base,
        checks: { lastRunAt: "2026-07-15T07:20:00.000Z", lastStatus: "ok", stale: false },
        bySeverity: { critical: 0, warning: 3, info: 0 },
      },
      "",
    );
    expect(m.subject).toBe("3 open data quality issues");
    expect(m.text).toContain("All administrations.");
  });
});

describe("addresses and keys", () => {
  it("normalizeFromAddress is a dot-atom check", () => {
    expect(normalizeFromAddress("Alerts@Camelthorncapital.com")).toBe(
      "alerts@camelthorncapital.com",
    );
    expect(normalizeFromAddress("first.last+tag@mail.example.co.uk")).toBe(
      "first.last+tag@mail.example.co.uk",
    );
    for (const bad of [
      ".a@b.com",
      "a.@b.com",
      "a..b@b.com",
      "a@.b.com",
      "a@b..com",
      "a@-b.com",
      "a@b-.com",
      "a@b.c",
      "a@b",
      "@b.com",
      "a@@b.com",
      "a b@b.com",
      "a@b.com.",
    ]) {
      expect(normalizeFromAddress(bad), bad).toBeNull();
    }
  });

  it("alert keys use the issue row id", () => {
    expect(alertKey(5, 0)).not.toBe(alertKey(6, 0));
    expect(alertKey(5, 1)).toBe("dq-alert:5:1");
    expect(legacyAlertKey("a:b", 1)).toBe("dq-alert:a:b:1");
  });
});
