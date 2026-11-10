import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
} from "@camelthorn/exact";
import {
  CLOSE_GUARD_MIN,
  SUBREQUEST_LIMIT,
  SUBREQUEST_RESERVE,
  acquireSyncLock,
  newMeter,
  syncDivision,
  type DivisionRef,
  type SyncMode,
  type SyncOptions,
  type SyncSummary,
} from "../src/exact/sync";
import {
  FakeExact,
  addDivision,
  auditRows,
  db,
  fakeGate,
  guid,
  resetSync,
  type FakeGate,
  type FakeItem,
} from "./sync-helpers";

const ACTOR = "finance@camelthorncapital.com";

let div: DivisionRef & { name: string };
let fx: FakeExact;
let gate: FakeGate;
let n = 0;

beforeEach(async () => {
  await resetSync();
  div = await addDivision();
  fx = new FakeExact(div.exactDivision);
  fx.divisions = [{ code: div.exactDivision, description: "Camelthorn Advisory B.V." }];
  gate = fakeGate();
});

const run = (
  mode: SyncMode,
  over: Partial<SyncOptions> = {},
  deps: { now?: () => number } = {},
): Promise<SyncSummary> =>
  syncDivision(
    env,
    div,
    { jobId: `test-${++n}`, mode, actor: ACTOR, ...over },
    { transport: fx.transport, gate, ...deps },
  );

function seedData(): void {
  fx.accounts = [
    { n: 1, name: "Acme BV", ts: 10, customer: true, email: "ap@acme.example" },
    { n: 2, name: "Supplier One", ts: 20, supplier: true, country: "DE" },
    { n: 3, name: "Tokyo KK", ts: 30, customer: true, country: "JP" },
  ];
  fx.receivables = [
    {
      n: 101,
      account: 1,
      name: "Acme BV",
      amount: 1234.5,
      currency: "EUR",
      invoiceNumber: 20240001,
      ts: 100,
    },
    {
      n: 102,
      account: 3,
      name: "Tokyo KK",
      amount: 1500,
      currency: "JPY",
      invoiceNumber: 20240002,
      ts: 110,
    },
    {
      n: 103,
      account: 1,
      name: "Acme BV",
      amount: -12.345,
      currency: "KWD",
      invoiceNumber: null,
      ts: 120,
    },
  ];
  fx.payables = [
    {
      n: 201,
      account: 2,
      name: "Supplier One",
      amount: 99.99,
      currency: "USD",
      invoiceNumber: 77,
      ts: 200,
    },
  ];
}

const items = async (): Promise<
  {
    exact_id: string;
    kind: string;
    status: string;
    currency: string;
    amount_minor: number;
    open_minor: number;
    closed_at: string | null;
    invoice_number: string | null;
    due_date: string | null;
    last_seen_sync_id: number | null;
  }[]
> =>
  (
    await db
      .prepare(
        `SELECT exact_id, kind, status, currency, amount_minor, open_minor, closed_at,
                invoice_number, due_date, last_seen_sync_id
         FROM open_items WHERE division_id = ?1 ORDER BY exact_id`,
      )
      .bind(div.id)
      .all()
  ).results as never;

const itemStatus = async (): Promise<Record<string, string>> =>
  Object.fromEntries((await items()).map((i) => [i.exact_id, i.status]));

const count = async (table: string): Promise<number> =>
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE division_id = ?1`)
      .bind(div.id)
      .first<{ n: number }>()
  )?.n ?? 0;

const stateRow = (entity: string) =>
  db
    .prepare("SELECT * FROM sync_state WHERE division_id = ?1 AND entity = ?2")
    .bind(div.id, entity)
    .first<{
      cursor: string;
      mode: string | null;
      last_status: string | null;
      last_error: string | null;
      last_completed_at: string | null;
      last_full_completed_at: string | null;
      rows_seen: number;
      calls_used: number;
    }>();

describe("full sync", () => {
  it("writes divisions, relations, open items in minor units, state and ONE audit row", async () => {
    seedData();
    const before = (await auditRows("exact.sync", div.id)).length;
    const s = await run("full");
    expect(s.status).toBe("ok");
    expect(s.callsUsed).toBe(7);
    expect(gate.started).toHaveLength(1);
    expect(gate.started[0]?.jobId).toMatch(/^test-/);
    expect(gate.ended).toHaveLength(1);

    // divisions: name updated from Exact
    const d = await db
      .prepare("SELECT name FROM divisions WHERE id = ?1")
      .bind(div.id)
      .first<{ name: string }>();
    expect(d?.name).toBe("Camelthorn Advisory B.V.");

    expect(await count("relations")).toBe(3);
    const acme = await db
      .prepare("SELECT * FROM relations WHERE division_id = ?1 AND exact_id = ?2")
      .bind(div.id, guid(1))
      .first<Record<string, unknown>>();
    expect(acme).toMatchObject({
      name: "Acme BV",
      is_customer: 1,
      is_supplier: 0,
      email: "ap@acme.example",
      iban: null,
      iban_changed_at: null,
    });

    const rows = await items();
    expect(rows).toHaveLength(4);
    const byId = Object.fromEntries(rows.map((r) => [r.exact_id, r]));
    // three currencies, three exponents: EUR 2, JPY 0, KWD 3 (and USD 2 on the payable)
    expect(byId[guid(101)]).toMatchObject({
      kind: "invoice",
      currency: "EUR",
      amount_minor: 123450,
      open_minor: 123450,
      status: "open",
      invoice_number: "20240001",
    });
    expect(byId[guid(102)]).toMatchObject({ currency: "JPY", open_minor: 1500 });
    expect(byId[guid(103)]).toMatchObject({
      currency: "KWD",
      open_minor: -12345,
      invoice_number: null,
    });
    expect(byId[guid(201)]).toMatchObject({ kind: "bill", currency: "USD", open_minor: 9999 });
    // /Date(1700000000000)/ is 2023-11-14T22:13:20Z, still the 14th in Amsterdam
    expect(byId[guid(101)]?.due_date).toBe("2023-11-14");
    expect(rows.every((r) => r.last_seen_sync_id === s.runSeq)).toBe(true);

    for (const e of ["divisions", "relations", "bank_accounts", "receivables", "payables", "run"]) {
      expect((await stateRow(e))?.last_status).toBe("ok");
    }
    expect((await stateRow("relations"))?.cursor).toBe("30");
    expect((await stateRow("run"))?.last_full_completed_at).not.toBeNull();
    expect((await stateRow("receivables"))?.rows_seen).toBe(3);

    const audit = await auditRows("exact.sync", div.id);
    expect(audit).toHaveLength(before + 1);
    expect(audit.at(-1)?.actor_email).toBe(ACTOR);
    const after = JSON.parse(audit.at(-1)?.after_json ?? "{}") as { status: string; mode: string };
    expect(after).toMatchObject({ status: "ok", mode: "full" });
  });

  it("uses the system actor by default and is safe to run twice (no duplicate rows)", async () => {
    seedData();
    await run("full", { actor: undefined });
    const first = { rel: await count("relations"), items: await count("open_items") };
    const second = await run("full", { actor: undefined });
    expect(second.status).toBe("ok");
    expect({ rel: await count("relations"), items: await count("open_items") }).toEqual(first);
    const audit = await auditRows("exact.sync", div.id);
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.actor_email === "system")).toBe(true);
    expect(second.runSeq).toBeGreaterThan(1);
  });

  it("ends the job even when an entity fails with an unexpected error", async () => {
    seedData();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fx.beforeCall = (call) => {
      if (call === 2) throw new TypeError("boom with NL91ABNA0417164300 inside");
    };
    const s = await run("full");
    expect(s.status).toBe("error");
    expect(gate.ended).toHaveLength(1);
    expect((await stateRow("run"))?.last_error).toBe("internal_error");
    expect(JSON.stringify(await auditRows("exact.sync", div.id))).not.toContain("ABNA");
  });

  it("records gate_unavailable when the job cannot start, and still releases the lock", async () => {
    gate = fakeGate({
      startJob: async () => {
        throw new Error("rpc down");
      },
    });
    const s = await run("full");
    // A gate that cannot start the job is transient: partial, retried by the next run.
    expect(s.status).toBe("partial");
    expect(fx.calls).toHaveLength(0);
    expect(gate.ended).toHaveLength(0);
    expect((await stateRow("run"))?.last_error).toBe("gate_unavailable");
    expect(await acquireSyncLock(db, div.id, "other", Date.now())).not.toBeNull();
  });
});

describe("closing items", () => {
  it("closes items missing from a COMPLETE full read, and reopens them if they come back", async () => {
    seedData();
    await run("full");
    fx.receivables = fx.receivables.filter((i) => i.n !== 103);
    fx.payables = [];
    const s = await run("full");
    expect(s.status).toBe("ok");
    expect(s.entities.receivables.closed).toBe(1);
    expect(s.entities.payables.closed).toBe(1);
    expect(await itemStatus()).toEqual({
      [guid(101)]: "open",
      [guid(102)]: "open",
      [guid(103)]: "closed",
      [guid(201)]: "closed",
    });
    const closed = (await items()).find((i) => i.exact_id === guid(103));
    expect(closed?.open_minor).toBe(0);
    expect(closed?.closed_at).not.toBeNull();

    fx.receivables.push({
      n: 103,
      account: 1,
      name: "Acme BV",
      amount: 5,
      currency: "EUR",
      invoiceNumber: 1,
      ts: 300,
    });
    await run("full");
    const back = (await items()).find((i) => i.exact_id === guid(103));
    expect(back).toMatchObject({
      status: "open",
      closed_at: null,
      open_minor: 500,
      currency: "EUR",
    });
  });

  it("never closes anything when the read of the entity did not complete (budget mid-read)", async () => {
    seedData();
    await run("full");
    fx.receivables = fx.receivables.slice(0, 2); // 103 looks paid
    fx.pageSize = 1;
    // call 1 divisions, 2 first receivables page, 3 second page: the budget ends here
    fx.beforeCall = (call, req) => {
      if (req.path === "/read/financial/ReceivablesList" && call > 2) {
        throw new ExactBudgetExhaustedError("x");
      }
    };
    const s = await run("full");
    expect(s.status).toBe("partial");
    expect(s.entities.receivables.status).toBe("partial");
    expect(s.entities.receivables.error).toBe("budget_exhausted");
    expect(s.entities.payables.status).toBe("skipped");
    expect(await itemStatus()).toEqual({
      [guid(101)]: "open",
      [guid(102)]: "open",
      [guid(103)]: "open",
      [guid(201)]: "open",
    });
    expect((await stateRow("receivables"))?.last_status).toBe("partial");
  });

  it("never closes after a failed read, and a failure in one entity does not stop the next", async () => {
    seedData();
    await run("full");
    fx.receivables = [];
    fx.payables = [];
    fx.override["/read/financial/ReceivablesList"] = () => ({
      status: 400,
      headers: {},
      body: '{"error":{"code":"","message":{"lang":"","value":"bad $select"}}}',
    });
    const s = await run("full");
    expect(s.status).toBe("error");
    expect(s.entities.receivables.status).toBe("error");
    expect(s.entities.receivables.error).toBe("http_400");
    // payables were read completely, so its (now vanished) bill is closed; receivables untouched
    expect(s.entities.payables.status).toBe("ok");
    expect(await itemStatus()).toEqual({
      [guid(101)]: "open",
      [guid(102)]: "open",
      [guid(103)]: "open",
      [guid(201)]: "closed",
    });
  });

  it("incremental mode never closes by absence, but closes an item whose open amount is zero", async () => {
    seedData();
    await run("full");
    fx.receivables = [fx.receivables[0] as (typeof fx.receivables)[number]];
    fx.payables = [];
    const s = await run("incremental");
    expect(s.status).toBe("ok");
    expect((await itemStatus())[guid(102)]).toBe("open");
    expect((await itemStatus())[guid(201)]).toBe("open");

    fx.receivables = [
      { ...(fx.receivables[0] as (typeof fx.receivables)[number]), amount: 0, ts: 999 },
    ];
    await run("incremental");
    const paid = (await items()).find((i) => i.exact_id === guid(101));
    expect(paid).toMatchObject({ status: "closed", open_minor: 0 });
    expect(paid?.closed_at).not.toBeNull();
  });
});

describe("resuming and cursors", () => {
  it("saves the cursor on budget exhaustion mid-entity and the next full run resumes from it", async () => {
    fx.pageSize = 1;
    fx.accounts = [10, 20, 30, 40, 50].map((ts, i) => ({ n: i + 1, name: `Rel ${i}`, ts }));
    fx.beforeCall = (call) => {
      // 1 divisions, 2 receivables, 3 payables, 4-5 relation pages, 6 dies
      if (call === 6) throw new ExactBudgetExhaustedError("x");
    };
    const first = await run("full", { chunkPages: 1 });
    expect(first.status).toBe("partial");
    expect(first.entities.relations).toMatchObject({
      status: "partial",
      rows: 2,
      error: "budget_exhausted",
    });
    expect(first.entities.bank_accounts.status).toBe("skipped");
    expect(await count("relations")).toBe(2);
    expect(await stateRow("relations")).toMatchObject({
      cursor: "20",
      last_status: "partial",
      mode: "full",
    });
    expect((await stateRow("run"))?.last_status).toBe("partial");
    expect((await stateRow("run"))?.last_full_completed_at).toBeNull();
    expect(gate.ended).toHaveLength(1);

    fx.beforeCall = () => undefined;
    fx.calls = [];
    const second = await run("full", { chunkPages: 1 });
    expect(second.status).toBe("ok");
    const firstAccountCall = fx.calls.find((c) => c.path === "/sync/CRM/Accounts");
    expect(firstAccountCall?.query?.["$filter"]).toBe("Timestamp gt 20L");
    expect(await count("relations")).toBe(5);
    expect(await stateRow("relations")).toMatchObject({ cursor: "50", last_status: "ok" });
  });

  it("a full run restarts relations from 0 when the last pass completed", async () => {
    seedData();
    await run("full");
    fx.calls = [];
    await run("full");
    const q = fx.calls.find((c) => c.path === "/sync/CRM/Accounts");
    expect(q?.query?.["$filter"]).toBe("Timestamp gt 0L");
  });

  it("incremental runs continue from the stored Timestamp cursors", async () => {
    seedData();
    await run("full");
    fx.calls = [];
    fx.accounts.push({ n: 4, name: "New one", ts: 40, supplier: true });
    fx.receivables.push({
      n: 104,
      account: 1,
      name: "Acme BV",
      amount: 10,
      currency: "EUR",
      invoiceNumber: 4,
      ts: 130,
    });
    const s = await run("incremental");
    expect(s.status).toBe("ok");
    expect(s.entities.relations.rows).toBe(1);
    const filters = Object.fromEntries(
      fx.calls
        .filter((c) => c.path.startsWith("/sync/"))
        .map((c) => [c.path, c.query?.["$filter"]]),
    );
    expect(filters["/sync/CRM/Accounts"]).toBe("Timestamp gt 30L");
    // open items had no incremental cursor yet: the first incremental pass reads from 0
    expect(filters["/sync/Cashflow/Receivables"]).toBe("Timestamp gt 0L");
    expect(fx.pathsCalled()).not.toContain("/read/financial/ReceivablesList");

    fx.calls = [];
    await run("incremental");
    const again = Object.fromEntries(
      fx.calls
        .filter((c) => c.path.startsWith("/sync/"))
        .map((c) => [c.path, c.query?.["$filter"]]),
    );
    expect(again["/sync/Cashflow/Receivables"]).toBe("Timestamp gt 130L");
    expect(again["/sync/Cashflow/Payables"]).toBe("Timestamp gt 200L");
    expect(again["/sync/CRM/Accounts"]).toBe("Timestamp gt 40L");
  });

  it("stops between steps at the deadline and finishes as partial", async () => {
    seedData();
    const s = await run("full", { deadlineMs: Date.now() - 1 });
    expect(s.status).toBe("partial");
    expect(s.entities.divisions).toMatchObject({ status: "partial", error: "time_limit" });
    expect(fx.calls).toHaveLength(0);
    expect(gate.ended).toHaveLength(1);
  });

  it("finishes as partial on a rate limit and keeps what it read", async () => {
    fx.pageSize = 1;
    fx.accounts = [10, 20, 30].map((ts, i) => ({ n: i + 1, name: `R${i}`, ts }));
    fx.beforeCall = (call) => {
      if (call === 5) throw new ExactRateLimitedError(30_000); // 2nd relation page
    };
    const s = await run("full", { chunkPages: 1 });
    expect(s.status).toBe("partial");
    expect(s.entities.relations.error).toBe("rate_limited");
    expect(await count("relations")).toBe(1);
  });
});

describe("authorisation failure", () => {
  it("records needs_reauth and stops without a retry loop", async () => {
    seedData();
    fx.beforeCall = () => {
      throw new ExactAuthError("needs_reauth");
    };
    const s = await run("full");
    expect(s.status).toBe("needs_reauth");
    expect(fx.calls).toHaveLength(1);
    expect(gate.ended).toHaveLength(1);
    expect(await stateRow("run")).toMatchObject({
      last_status: "needs_reauth",
      last_error: "needs_reauth",
    });
    expect(await stateRow("divisions")).toMatchObject({ last_status: "needs_reauth" });
    expect(await stateRow("relations")).toBeNull();
    expect(await auditRows("exact.sync", div.id)).toHaveLength(1);
  });

  it("maps a rejected token (unauthorized) the same way", async () => {
    fx.beforeCall = () => {
      throw new ExactAuthError("unauthorized");
    };
    const s = await run("incremental");
    expect(s.status).toBe("needs_reauth");
    expect((await stateRow("run"))?.last_error).toBe("unauthorized");
  });

  it("a non-auth API error is recorded with a short code and the other entities still run", async () => {
    seedData();
    fx.beforeCall = (_n, req) => {
      if (req.path === "/system/Divisions") throw new ExactApiError(400, "x", "bad_request");
    };
    const s = await run("full");
    expect(s.status).toBe("error");
    expect(s.entities.divisions.error).toBe("bad_request");
    expect(s.entities.relations.status).toBe("ok");
  });
});

describe("IBAN changes", () => {
  const relId = (m: number): string => `${div.id}:${guid(m)}`;
  const relation = (m: number) =>
    db
      .prepare(
        "SELECT iban, iban_changed_at FROM relations WHERE division_id = ?1 AND exact_id = ?2",
      )
      .bind(div.id, guid(m))
      .first<{ iban: string | null; iban_changed_at: string | null }>();

  it("stores the first IBAN without flagging it, then flags a change with a MASKED audit row", async () => {
    seedData();
    fx.banks = [{ n: 1, account: 2, iban: "NL91 ABNA 0417 1643 00" }];
    await run("full");
    expect(await relation(2)).toEqual({ iban: "NL91ABNA0417164300", iban_changed_at: null });
    expect(await auditRows("relation.iban_changed", relId(2))).toHaveLength(0);

    await run("full"); // unchanged: nothing
    expect(await auditRows("relation.iban_changed", relId(2))).toHaveLength(0);

    fx.banks = [{ n: 1, account: 2, iban: "DE89370400440532013000" }];
    await run("full", { actor: "approver@camelthorncapital.com" });
    expect(await relation(2)).toMatchObject({ iban: "DE89370400440532013000" });
    expect((await relation(2))?.iban_changed_at).not.toBeNull();
    const rows = await auditRows("relation.iban_changed", relId(2));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_email).toBe("approver@camelthorncapital.com");
    const text = `${rows[0]?.before_json} ${rows[0]?.after_json}`;
    expect(text).toContain("NL91****4300");
    expect(text).toContain("DE89****3000");
    expect(text).not.toContain("ABNA");
    expect(text).not.toContain("0417");
    expect(text).not.toContain("0532013000");

    await run("full"); // same IBAN again: no second row
    expect(await auditRows("relation.iban_changed", relId(2))).toHaveLength(1);

    // Case and spacing differences are not a change.
    fx.banks = [{ n: 1, account: 2, iban: "de89 3704 0044 0532 0130 00" }];
    await run("full");
    expect(await auditRows("relation.iban_changed", relId(2))).toHaveLength(1);
  });

  it("flags a first IBAN that appears on a relation we already knew", async () => {
    seedData();
    await run("full"); // IBAN pass completes with no IBANs
    fx.banks = [{ n: 1, account: 1, iban: "NL02ABNA0123456789" }];
    await run("full");
    expect((await relation(1))?.iban_changed_at).not.toBeNull();
    const rows = await auditRows("relation.iban_changed", relId(1));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.before_json).toBe('{"iban":null}');
  });

  it("prefers the main bank account, ignores accounts of unknown relations", async () => {
    seedData();
    fx.banks = [
      { n: 1, account: 2, iban: "NL02ABNA0123456789", main: false },
      { n: 2, account: 2, iban: "NL91ABNA0417164300", main: true },
      { n: 3, account: 999, iban: "NL86INGB0002445588" },
      { n: 4, account: 3, iban: null },
    ];
    await run("full");
    expect((await relation(2))?.iban).toBe("NL91ABNA0417164300");
    expect((await relation(3))?.iban).toBeNull();
  });
});

describe("locking", () => {
  it("answers locked and touches nothing while another run holds the division", async () => {
    seedData();
    expect(await acquireSyncLock(db, div.id, "someone", Date.now())).toBe(1);
    const s = await run("full");
    expect(s.status).toBe("locked");
    expect(fx.calls).toHaveLength(0);
    expect(gate.started).toHaveLength(0);
    expect(await auditRows("exact.sync", div.id)).toHaveLength(0);
  });

  it("takes over a lease that has expired (crashed run)", async () => {
    seedData();
    await acquireSyncLock(db, div.id, "crashed", Date.now() - 20 * 60_000);
    const s = await run("full");
    expect(s.status).toBe("ok");
  });

  it("lets exactly one of two concurrent runs through", async () => {
    seedData();
    const [a, b] = await Promise.all([run("full"), run("full")]);
    expect([a.status, b.status].sort()).toEqual(["locked", "ok"]);
    expect(await auditRows("exact.sync", div.id)).toHaveLength(1);
    // released afterwards
    expect((await run("full")).status).toBe("ok");
  });

  it("is per division: another division is not blocked", async () => {
    const other = await addDivision();
    expect(await acquireSyncLock(db, other.id, "x", Date.now())).toBe(1);
    seedData();
    expect((await run("full")).status).toBe("ok");
  });
});

describe("closing guards (review E3)", () => {
  const manyOpen = (count: number): void => {
    fx.receivables = Array.from({ length: count }, (_, i) => ({
      n: 300 + i,
      account: 1,
      name: "Acme BV",
      amount: 10 + i,
      currency: "EUR",
      invoiceNumber: 300 + i,
      ts: 300 + i,
    }));
  };

  it("refuses to close everything when a complete list is suddenly empty (more than the guard)", async () => {
    seedData();
    manyOpen(CLOSE_GUARD_MIN + 1);
    await run("full");
    fx.receivables = [];
    const s = await run("full");
    expect(s.status).toBe("error");
    expect(s.entities.receivables).toMatchObject({ status: "error", error: "close_guard" });
    expect(s.entities.receivables.closed).toBeUndefined();
    expect(Object.values(await itemStatus()).every((v) => v === "open")).toBe(true);
    expect((await stateRow("receivables"))?.last_error).toBe("close_guard");
    expect((await stateRow("run"))?.last_full_completed_at).not.toBeNull(); // from the first run

    // An admin override closes them, and is audited.
    const forced = await run("full", { allowLargeClose: true });
    expect(forced.status).toBe("ok");
    expect(forced.entities.receivables.closed).toBe(CLOSE_GUARD_MIN + 1);
    const audit = await auditRows("exact.sync", div.id);
    expect(JSON.parse(audit.at(-1)?.after_json ?? "{}")).toMatchObject({ allowLargeClose: true });
  });

  it("closes a small set (at most the guard) when a complete list is empty", async () => {
    seedData();
    manyOpen(CLOSE_GUARD_MIN);
    await run("full");
    fx.receivables = [];
    const s = await run("full");
    expect(s.status).toBe("ok");
    expect(s.entities.receivables.closed).toBe(CLOSE_GUARD_MIN);
  });

  it("never closes items of another division, nor of the other kind", async () => {
    seedData();
    await run("full");
    const other = await addDivision();
    const fx2 = new FakeExact(other.exactDivision);
    fx2.divisions = [{ code: other.exactDivision, description: "Other" }];
    const s = await syncDivision(
      env,
      other,
      { jobId: `test-${++n}`, mode: "full" },
      { transport: fx2.transport, gate },
    );
    expect(s.status).toBe("ok");
    expect(Object.values(await itemStatus()).every((v) => v === "open")).toBe(true);

    // Payables empty but receivables complete: only the bill closes.
    fx.payables = [];
    await run("full");
    expect((await itemStatus())[guid(201)]).toBe("closed");
    expect((await itemStatus())[guid(101)]).toBe("open");
  });

  it("closes nothing when the lease was taken over by another run before the close", async () => {
    seedData();
    await run("full");
    fx.receivables = [];
    fx.payables = [];
    let stolen = false;
    const transport = async (req: Parameters<typeof fx.transport>[0]) => {
      if (req.path === "/read/financial/PayablesList" && !stolen) {
        stolen = true;
        // Simulate: our lease expired and a newer run took the division over.
        await db
          .prepare(
            "UPDATE sync_locks SET holder = 'newer', run_seq = run_seq + 1 WHERE division_id = ?1",
          )
          .bind(div.id)
          .run();
      }
      return fx.transport(req);
    };
    const s = await syncDivision(
      env,
      div,
      { jobId: `test-${++n}`, mode: "full" },
      { transport, gate },
    );
    expect(s.entities.receivables.status).toBe("ok");
    expect(Object.values(await itemStatus()).every((v) => v === "open")).toBe(true);
    expect(s.entities.receivables.closed).toBe(0);
    // Our release did not free the newer run's lease.
    expect(await acquireSyncLock(db, div.id, "third", Date.now())).toBeNull();
  });

  it("an older run never overwrites or un-sees a row a newer run wrote", async () => {
    seedData();
    await run("full");
    await db
      .prepare("UPDATE open_items SET last_seen_sync_id = 999, open_minor = 1 WHERE exact_id = ?1")
      .bind(guid(101))
      .run();
    fx.receivables = fx.receivables.filter((i) => i.n !== 101);
    const s = await run("full");
    expect(s.status).toBe("ok");
    const row = (await items()).find((i) => i.exact_id === guid(101));
    expect(row).toMatchObject({ status: "open", open_minor: 1, last_seen_sync_id: 999 });
  });

  it("stops at the deadline in the middle of a bulk read, closes nothing", async () => {
    seedData();
    await run("full");
    fx.receivables = fx.receivables.slice(0, 2); // 103 looks paid
    fx.pageSize = 1; // two pages: the deadline passes after the first one
    let clock = Date.now();
    const deadline = clock + 1000;
    fx.beforeCall = (_n, req) => {
      if (req.path === "/read/financial/ReceivablesList") clock = deadline + 1;
    };
    const s = await run("full", { deadlineMs: deadline }, { now: () => clock });
    expect(s.status).toBe("partial");
    expect(s.entities.receivables).toMatchObject({ status: "partial", error: "time_limit" });
    expect(Object.values(await itemStatus()).every((v) => v === "open")).toBe(true);
    expect(gate.ended).toHaveLength(2);
  });

  it("stops before the invocation's subrequest limit as partial, closing nothing", async () => {
    seedData();
    await run("full");
    fx.receivables = [];
    const meter = newMeter(SUBREQUEST_RESERVE + 8);
    const s = await run("full", { meter });
    expect(s.status).toBe("partial");
    expect(Object.values(s.entities).some((e) => e.error === "subrequest_limit")).toBe(true);
    expect(meter.used).toBeLessThanOrEqual(meter.limit);
    expect(Object.values(await itemStatus()).every((v) => v === "open")).toBe(true);
    expect(gate.ended).toHaveLength(2); // the seeding run and this one
    // A meter with nothing left does not even take the lock.
    const empty = { used: SUBREQUEST_LIMIT, limit: SUBREQUEST_LIMIT };
    const none = await run("full", { meter: empty });
    expect(none).toMatchObject({ status: "partial", runSeq: null });
    expect(await acquireSyncLock(db, div.id, "x", Date.now())).not.toBeNull();
  });

  it("releases the lock when the run throws in its final write", async () => {
    seedData();
    const failing = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, prop, recv) {
          if (prop === "batch") {
            return async (stmts: D1PreparedStatement[]) => {
              // The final batch carries the audit row: fail that one.
              if (stmts.length > 0 && stmts.length === 7) throw new Error("d1 down");
              return target.batch(stmts);
            };
          }
          const v = Reflect.get(target, prop, recv) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }),
    };
    await expect(
      syncDivision(
        failing,
        div,
        { jobId: `test-${++n}`, mode: "incremental" },
        { transport: fx.transport, gate },
      ),
    ).rejects.toThrow("d1 down");
    expect(gate.ended).toHaveLength(1);
    expect(await acquireSyncLock(db, div.id, "x", Date.now())).not.toBeNull();
  });
});

describe("amount model (review E3)", () => {
  it("stores the open balance, the original total, the division-currency amount and the rate", async () => {
    seedData();
    const usd = await addDivision();
    const fx2 = new FakeExact(usd.exactDivision);
    fx2.divisions = [{ code: usd.exactDivision, description: "USD" }];
    fx2.accounts = [{ n: 1, name: "Acme", ts: 1, customer: true }];
    fx2.receivables = [
      {
        n: 1,
        account: 1,
        name: "Acme",
        amount: 400.1, // open after a part payment
        original: 1000,
        amountDc: 368.55,
        rate: 0.92112,
        currency: "USD",
        invoiceNumber: 1,
        ts: 5,
      },
    ];
    const sync = (mode: SyncMode) =>
      syncDivision(
        env,
        { ...usd, currency: "EUR" },
        { jobId: `test-${++n}`, mode },
        { transport: fx2.transport, gate },
      );
    expect((await sync("incremental")).status).toBe("ok");
    const read = () =>
      db
        .prepare(
          `SELECT amount_minor, open_minor, original_minor, open_dc_minor, dc_currency, rate, status
           FROM open_items WHERE division_id = ?1`,
        )
        .bind(usd.id)
        .first();
    expect(await read()).toEqual({
      amount_minor: 100000,
      open_minor: 40010,
      original_minor: 100000,
      open_dc_minor: 36855,
      dc_currency: "EUR",
      rate: "0.92112",
      status: "open",
    });

    // The nightly bulk list has only the open amount: original and rate are kept, the
    // division-currency snapshot is cleared rather than left stale.
    fx2.receivables = [{ ...(fx2.receivables[0] as FakeItem), amount: 100 }];
    expect((await sync("full")).status).toBe("ok");
    expect(await read()).toEqual({
      amount_minor: 100000,
      open_minor: 10000,
      original_minor: 100000,
      open_dc_minor: null,
      dc_currency: null,
      rate: "0.92112",
      status: "open",
    });

    // Fully paid per Exact: closed, open zero.
    fx2.receivables = [
      { ...(fx2.receivables[0] as FakeItem), amountDc: 92.11, fullyPaid: true, ts: 9 },
    ];
    await sync("incremental");
    expect(await read()).toMatchObject({ open_minor: 0, open_dc_minor: 0, status: "closed" });
  });
});
