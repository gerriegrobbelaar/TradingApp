/**
 * ECB rate conflicts with a resolution path (Phase 6 review S9, ADR 0039): the importer records
 * them, GET /api/fx/conflicts lists them, POST .../resolve keeps or accepts, and the strict rate
 * table refuses a date that still has one.
 */
import type {
  FxConflictResolveResponse,
  FxConflictsResponse,
  FxRatesResponse,
} from "@camelthorn/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeObservations } from "../src/fx/ecb-import";
import { loadRateTableExactly } from "../src/fx/rate-table";
import { auditOf, db, fxRows, resetFx } from "./fx-helpers";
import { addSession, addUser, authed, call, resetDb } from "./helpers";

// Wednesday 11 November 2026, 12:00 Amsterdam.
const NOW = Date.parse("2026-11-11T11:00:00Z");
const NOW_ISO = new Date(NOW).toISOString();
const ADMIN = "admin@camelthorncapital.com";
let tokens: Record<string, string> = {};
// audit_log is append-only: each test looks only at the rows written after it started.
let auditBase = 0;
const newAudits = async () => (await auditOf("fx.rate_conflict_resolved")).slice(auditBase);

const put = (currency: string, date: string, rate: string) =>
  db
    .prepare("INSERT INTO fx_rates (currency, rate_date, rate) VALUES (?1, ?2, ?3)")
    .bind(currency, date, rate)
    .run();

const obs = (currency: string, rateDate: string, rate: string) => ({ currency, rateDate, rate });
const seen = (rows: { currency: string; date: string; ecb: string }[]) =>
  storeObservations(
    db,
    rows.map((r) => obs(r.currency, r.date, r.ecb)),
    "2026-10-01",
    "2026-11-11",
    NOW_ISO,
  );

interface ConflictDb {
  id: number;
  currency: string;
  rate_date: string;
  stored_rate: string;
  ecb_rate: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
}
const conflicts = async (): Promise<ConflictDb[]> =>
  (await db.prepare("SELECT * FROM fx_rate_conflicts ORDER BY id").all<ConflictDb>()).results;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
  await resetFx();
  await db.prepare("DELETE FROM fx_rate_conflicts").run();
  auditBase = (await auditOf("fx.rate_conflict_resolved")).length;
  tokens = {};
  for (const role of ["admin", "finance", "approver", "viewer"] as const) {
    tokens[role] = await addSession(await addUser(`${role}@camelthorncapital.com`, [role]));
  }
});
afterEach(() => vi.useRealTimers());

describe("the importer records conflicts", () => {
  it("one conflict row per (currency, date, ECB value), with the audit row, idempotent", async () => {
    await put("USD", "2026-11-09", "1.09");
    const auditBefore = (await auditOf("fx.rate_conflict")).length;
    expect(await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.1" }])).toMatchObject({
      conflicts: 1,
      inserted: 0,
    });
    expect(await conflicts()).toMatchObject([
      {
        currency: "USD",
        rate_date: "2026-11-09",
        stored_rate: "1.09",
        ecb_rate: "1.1",
        resolved_at: null,
      },
    ]);
    expect((await auditOf("fx.rate_conflict")).length).toBe(auditBefore + 1);
    // the stored rate is never touched by the importer
    expect(await fxRows()).toEqual([{ currency: "USD", rate_date: "2026-11-09", rate: "1.09" }]);

    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.1" }]);
    expect(await conflicts()).toHaveLength(1);
    expect((await auditOf("fx.rate_conflict")).length).toBe(auditBefore + 1);
  });

  it("an equal rate (any spelling) is no conflict", async () => {
    await put("USD", "2026-11-09", "1.09");
    expect(await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.0900" }])).toMatchObject({
      conflicts: 0,
    });
    expect(await conflicts()).toEqual([]);
  });

  it("does not re-open a resolved conflict for the same value, but a NEW value is a new conflict", async () => {
    await put("USD", "2026-11-09", "1.09");
    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.1" }]);
    const first = (await conflicts())[0] as ConflictDb;
    const res = await post(first.id, { resolution: "kept", confirm: true });
    expect(res.status).toBe(200);
    const audits = (await auditOf("fx.rate_conflict")).length;

    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.1" }]); // same value again
    expect(await conflicts()).toMatchObject([{ resolution: "kept" }]);
    expect((await auditOf("fx.rate_conflict")).length).toBe(audits);

    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.12" }]); // a new value
    expect(await conflicts()).toMatchObject([
      { ecb_rate: "1.1", resolution: "kept" },
      { ecb_rate: "1.12", resolution: null, resolved_at: null },
    ]);
    expect((await auditOf("fx.rate_conflict")).length).toBe(audits + 1);
  });

  it("re-opens a resolved conflict when the stored rate has changed since (flip-flop)", async () => {
    await put("USD", "2026-11-09", "1.1");
    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.2" }]); // c1: stored 1.1, ecb 1.2
    const c1 = (await conflicts())[0] as ConflictDb;
    await post(c1.id, { resolution: "accepted", confirm: true });
    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.3" }]); // c2: stored 1.2, ecb 1.3
    const c2 = (await conflicts())[1] as ConflictDb;
    await post(c2.id, { resolution: "accepted", confirm: true });
    expect((await fxRows())[0]?.rate).toBe("1.3");
    // the ECB goes back to 1.2: stored is now 1.3, a different situation than c1 was resolved in
    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.2" }]);
    expect(await conflicts()).toMatchObject([
      { ecb_rate: "1.2", stored_rate: "1.3", resolved_at: null, resolution: null },
      { ecb_rate: "1.3", resolution: "accepted" },
    ]);
  });
});

async function post(id: number | string, body: unknown, role = "admin", extra: RequestInit = {}) {
  return authed(`/api/fx/conflicts/${id}/resolve`, tokens[role] as string, {
    method: "POST",
    json: body,
    ...extra,
  });
}
const getList = async (role = "admin", q = "") => {
  const res = await authed(`/api/fx/conflicts${q}`, tokens[role] as string);
  return { status: res.status, body: (await res.json()) as FxConflictsResponse };
};

describe("GET /api/fx/conflicts", () => {
  beforeEach(async () => {
    await put("USD", "2026-11-09", "1.09");
    await put("GBP", "2026-11-06", "0.86");
    await seen([
      { currency: "USD", date: "2026-11-09", ecb: "1.1" },
      { currency: "GBP", date: "2026-11-06", ecb: "0.87" },
    ]);
  });

  it("admin and finance may read; approver, viewer and anonymous may not", async () => {
    expect((await getList("admin")).status).toBe(200);
    expect((await getList("finance")).status).toBe(200);
    expect((await getList("approver")).status).toBe(403);
    expect((await getList("viewer")).status).toBe(403);
    expect((await call("/api/fx/conflicts")).status).toBe(401);
  });

  it("lists unresolved conflicts, newest date first, with the documented shape", async () => {
    const { body } = await getList("finance");
    expect(body.unresolvedCount).toBe(2);
    expect(body.conflicts.map((c) => `${c.currency}@${c.rateDate}`)).toEqual([
      "USD@2026-11-09",
      "GBP@2026-11-06",
    ]);
    expect(Object.keys(body.conflicts[0] as object).sort()).toEqual(
      [
        "id",
        "currency",
        "rateDate",
        "storedRate",
        "ecbRate",
        "firstSeenAt",
        "resolved",
        "resolvedAt",
        "resolvedBy",
        "resolution",
      ].sort(),
    );
    expect(body.conflicts[0]).toMatchObject({
      storedRate: "1.09",
      ecbRate: "1.1",
      firstSeenAt: NOW_ISO,
      resolved: false,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    });
  });

  it("resolved ones are hidden unless ?resolved=1, and then come last", async () => {
    const usd = (await conflicts()).find((c) => c.currency === "USD") as ConflictDb;
    await post(usd.id, { resolution: "kept", confirm: true });
    const open = await getList();
    expect(open.body.unresolvedCount).toBe(1);
    expect(open.body.conflicts.map((c) => c.currency)).toEqual(["GBP"]);
    const all = await getList("admin", "?resolved=1");
    expect(all.body.conflicts.map((c) => [c.currency, c.resolved])).toEqual([
      ["GBP", false],
      ["USD", true],
    ]);
    expect(all.body.conflicts[1]).toMatchObject({
      resolution: "kept",
      resolvedBy: ADMIN,
      resolvedAt: NOW_ISO,
    });
  });

  it("GET /api/fx/rates carries the unresolved count", async () => {
    const res = await authed("/api/fx/rates", tokens["viewer"] as string);
    expect(((await res.json()) as FxRatesResponse).unresolvedConflicts).toBe(2);
    const usd = (await conflicts()).find((c) => c.currency === "USD") as ConflictDb;
    await post(usd.id, { resolution: "kept", confirm: true });
    const again = await authed("/api/fx/rates", tokens["viewer"] as string);
    expect(((await again.json()) as FxRatesResponse).unresolvedConflicts).toBe(1);
  });
});

describe("POST /api/fx/conflicts/:id/resolve", () => {
  let id: number;
  beforeEach(async () => {
    await put("USD", "2026-11-09", "1.09");
    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.1" }]);
    id = ((await conflicts())[0] as ConflictDb).id;
  });

  it("is admin only, needs a fresh sign-in and the CSRF header", async () => {
    const body = { resolution: "accepted", confirm: true };
    expect((await post(id, body, "finance")).status).toBe(403);
    expect((await post(id, body, "approver")).status).toBe(403);
    expect((await post(id, body, "viewer")).status).toBe(403);
    expect(
      (
        await call(`/api/fx/conflicts/${id}/resolve`, {
          method: "POST",
          headers: { "x-requested-with": "fetch", "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401);
    // no CSRF header
    const noCsrf = await call(`/api/fx/conflicts/${id}/resolve`, {
      method: "POST",
      headers: { cookie: `__Host-session=${tokens["admin"]}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(noCsrf.status).toBe(403);
    // stale sign-in: step-up required
    const old = await addSession(await addUser("old@camelthorncapital.com", ["admin"]), {
      lastAuthAgoMs: 20 * 60_000,
    });
    const stale = await authed(`/api/fx/conflicts/${id}/resolve`, old, {
      method: "POST",
      json: body,
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: "step_up_required" });
    // nothing changed by any of those
    expect(await conflicts()).toMatchObject([{ resolved_at: null }]);
    expect((await fxRows())[0]?.rate).toBe("1.09");
    expect(await newAudits()).toEqual([]);
  });

  it("validates the body and the id", async () => {
    const bad: [unknown, string][] = [
      [{ resolution: "accepted" }, "confirm_required"],
      [{ resolution: "accepted", confirm: "yes" }, "confirm_required"],
      [{ resolution: "accepted", confirm: false }, "confirm_required"],
      [{ resolution: "maybe", confirm: true }, "bad_resolution"],
      [{ confirm: true }, "bad_resolution"],
      [{ resolution: "kept", confirm: true, extra: 1 }, "bad_request"],
      [[], "bad_request"],
      ["x", "bad_request"],
    ];
    for (const [b, code] of bad) {
      const res = await post(id, b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(await res.json()).toEqual({ error: code });
    }
    for (const badId of ["0", "-1", "x", "1.5", "99999999999"]) {
      expect((await post(badId, { resolution: "kept", confirm: true })).status, badId).toBe(404);
    }
    expect((await post(9999, { resolution: "kept", confirm: true })).status).toBe(404);
    const notJson = await authed(`/api/fx/conflicts/${id}/resolve`, tokens["admin"] as string, {
      method: "POST",
      body: "nope",
    });
    expect(notJson.status).toBe(400);
    expect(await conflicts()).toMatchObject([{ resolved_at: null }]);
  });

  it("kept: marks it resolved, leaves the rate, audits who and what", async () => {
    const res = await post(id, { resolution: "kept", confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FxConflictResolveResponse;
    expect(body.alreadyResolved).toBe(false);
    expect(body.conflict).toMatchObject({
      id,
      resolved: true,
      resolution: "kept",
      resolvedBy: ADMIN,
      storedRate: "1.09",
      ecbRate: "1.1",
    });
    expect((await fxRows())[0]?.rate).toBe("1.09");
    const audit = await newAudits();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entity_id).toBe("USD@2026-11-09");
    expect(JSON.parse(audit[0]?.after_json ?? "{}")).toEqual({
      rate: "1.09",
      resolution: "kept",
      ecb: "1.1",
      conflictId: id,
    });
  });

  it("accepted: replaces the stored rate with the ECB value and audits before and after", async () => {
    const res = await post(id, { resolution: "accepted", confirm: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as FxConflictResolveResponse).conflict).toMatchObject({
      resolution: "accepted",
      resolved: true,
    });
    expect(await fxRows()).toEqual([{ currency: "USD", rate_date: "2026-11-09", rate: "1.1" }]);
    const row = await db
      .prepare("SELECT source, fetched_at FROM fx_rates WHERE currency = 'USD'")
      .first();
    expect(row).toEqual({ source: "ECB", fetched_at: NOW_ISO });
    const [audit] = await newAudits();
    expect(JSON.parse(audit?.after_json ?? "{}")).toMatchObject({
      rate: "1.1",
      resolution: "accepted",
    });
    const before = await db
      .prepare(
        "SELECT before_json, actor_email FROM audit_log WHERE action = 'fx.rate_conflict_resolved'",
      )
      .first<{ before_json: string; actor_email: string }>();
    expect(JSON.parse(before?.before_json ?? "{}")).toEqual({ rate: "1.09" });
    expect(before?.actor_email).toBe(ADMIN);
    // the public API serves the accepted value
    const rates = (await (
      await authed("/api/fx/rates", tokens["viewer"] as string)
    ).json()) as FxRatesResponse;
    expect(rates.rates[0]?.rate).toBe("1.1");
    expect(rates.unresolvedConflicts).toBe(0);
  });

  it("is idempotent: the same resolution again changes and audits nothing; the other one is refused", async () => {
    await post(id, { resolution: "accepted", confirm: true });
    const again = await post(id, { resolution: "accepted", confirm: true });
    expect(again.status).toBe(200);
    expect(((await again.json()) as FxConflictResolveResponse).alreadyResolved).toBe(true);
    expect(await newAudits()).toHaveLength(1);
    expect((await fxRows())[0]?.rate).toBe("1.1");

    const other = await post(id, { resolution: "kept", confirm: true });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "already_resolved_differently" });
    expect((await fxRows())[0]?.rate).toBe("1.1");
    expect(await newAudits()).toHaveLength(1);
  });

  it("is atomic: if the resolved mark cannot be written, the rate and the audit row are not either", async () => {
    await db.exec(
      "CREATE TRIGGER t_block_resolve BEFORE UPDATE ON fx_rate_conflicts BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    try {
      await expect(post(id, { resolution: "accepted", confirm: true })).resolves.toMatchObject({
        status: 500,
      });
    } finally {
      await db.exec("DROP TRIGGER t_block_resolve");
    }
    expect((await fxRows())[0]?.rate).toBe("1.09");
    expect(await newAudits()).toEqual([]);
    expect(await conflicts()).toMatchObject([{ resolved_at: null }]);
    // and it works afterwards
    expect((await post(id, { resolution: "accepted", confirm: true })).status).toBe(200);
    expect((await fxRows())[0]?.rate).toBe("1.1");
  });

  it("a conflict whose stored rate is gone is stale (409) and changes nothing", async () => {
    await db.prepare("DELETE FROM fx_rates WHERE currency = 'USD'").run();
    const res = await post(id, { resolution: "accepted", confirm: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_conflict" });
    expect(await newAudits()).toEqual([]);
  });
});

describe("resolve: review of T1 (races, rate canonical and from the stored row only)", () => {
  let id: number;
  beforeEach(async () => {
    await put("USD", "2026-11-09", "1.09");
    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.1" }]);
    id = ((await conflicts())[0] as ConflictDb).id;
  });

  it("two admins deciding differently at the same time: one wins, the other gets 409", async () => {
    const second = await addSession(await addUser("admin2@camelthorncapital.com", ["admin"]));
    const [a, b] = await Promise.all([
      post(id, { resolution: "accepted", confirm: true }),
      authed(`/api/fx/conflicts/${id}/resolve`, second, {
        method: "POST",
        json: { resolution: "kept", confirm: true },
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const [c] = await conflicts();
    expect(await newAudits()).toHaveLength(1);
    // the rate is what the winner decided
    expect((await fxRows())[0]?.rate).toBe(c?.resolution === "accepted" ? "1.1" : "1.09");
  });

  it("the accepted value is the stored conflict's, in canonical form; the body cannot carry one", async () => {
    const res = await post(id, { resolution: "accepted", confirm: true, rate: "9.99" });
    expect(res.status).toBe(400);
    await db
      .prepare("UPDATE fx_rate_conflicts SET ecb_rate = '1.1000' WHERE id = ?1")
      .bind(id)
      .run();
    expect((await post(id, { resolution: "accepted", confirm: true })).status).toBe(200);
    expect((await fxRows())[0]?.rate).toBe("1.1");
    const [audit] = await newAudits();
    expect(JSON.parse(audit?.after_json ?? "{}")).toMatchObject({ rate: "1.1", ecb: "1.1" });
  });

  it("a malformed ECB value (an old audit row copied by the migration) can be kept, never accepted", async () => {
    await db.prepare("UPDATE fx_rate_conflicts SET ecb_rate = '1e3' WHERE id = ?1").bind(id).run();
    const res = await post(id, { resolution: "accepted", confirm: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bad_conflict_rate" });
    expect((await fxRows())[0]?.rate).toBe("1.09");
    expect(await newAudits()).toEqual([]);
    expect((await post(id, { resolution: "kept", confirm: true })).status).toBe(200);
    expect((await fxRows())[0]?.rate).toBe("1.09");
  });

  it("two ECB values for one date: accepting one, then the other, each against the rate then stored", async () => {
    await seen([{ currency: "USD", date: "2026-11-09", ecb: "1.2" }]);
    const [first, other] = await conflicts();
    expect(
      (await post(first?.id as number, { resolution: "accepted", confirm: true })).status,
    ).toBe(200);
    expect((await fxRows())[0]?.rate).toBe("1.1");
    expect(
      (await post(other?.id as number, { resolution: "accepted", confirm: true })).status,
    ).toBe(200);
    expect((await fxRows())[0]?.rate).toBe("1.2");
    const befores = (
      await db
        .prepare(
          "SELECT before_json FROM audit_log WHERE action = 'fx.rate_conflict_resolved' ORDER BY id",
        )
        .all<{ before_json: string }>()
    ).results.slice(auditBase);
    expect(befores.map((a) => JSON.parse(a.before_json))).toEqual([
      { rate: "1.09" },
      { rate: "1.1" },
    ]);
  });
});

describe("the strict rate table follows the conflicts", () => {
  it("refuses the date until the conflict is resolved, then serves the resolved rate", async () => {
    await put("USD", "2026-10-30", "1.1650");
    await seen([{ currency: "USD", date: "2026-10-30", ecb: "1.17" }]);
    expect(await loadRateTableExactly(db, "2026-10-30", ["USD"])).toMatchObject({
      ok: false,
      error: "unresolved_conflict",
      currencies: ["USD"],
    });
    const id = ((await conflicts())[0] as ConflictDb).id;
    await post(id, { resolution: "accepted", confirm: true });
    expect(await loadRateTableExactly(db, "2026-10-30", ["USD"])).toMatchObject({
      ok: true,
      table: { rates: { USD: "1.17" } },
    });
  });
});
