import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExactApiError, ExactBudgetExhaustedError, ExactRateLimitedError } from "@camelthorn/exact";
import {
  CLOSE_GUARD_FRACTION,
  CLOSE_GUARD_MIN,
  CYCLE_MAX_AGE_MS,
  MAX_TRANSIENT_RETRIES,
  closeAllowed,
  syncDivision,
  type DivisionRef,
  type SyncMode,
  type SyncOptions,
  type SyncSummary,
} from "../src/exact/sync";
import {
  FakeExact,
  addDivision,
  db,
  fakeGate,
  guid,
  resetSync,
  type FakeGate,
  type FakeItem,
} from "./sync-helpers";

let div: DivisionRef & { name: string };
let fx: FakeExact;
let gate: FakeGate;
let n = 0;
let clock = Date.parse("2026-07-15T10:00:00Z");

beforeEach(async () => {
  await resetSync();
  div = await addDivision();
  fx = new FakeExact(div.exactDivision);
  fx.divisions = [{ code: div.exactDivision, description: "BV" }];
  gate = fakeGate();
  clock = Date.parse("2026-07-15T10:00:00Z");
});

const run = (mode: SyncMode, over: Partial<SyncOptions> = {}): Promise<SyncSummary> =>
  syncDivision(
    env,
    div,
    { jobId: `resume-${++n}`, mode, actor: "system", ...over },
    { transport: fx.transport, gate, now: () => clock },
  );

/**
 * A run with `budget` Exact calls: the fake throws the gate's budget error on the next one, as
 * the real ExactGate does. Resets the call log so `fx.calls` is that run's calls.
 */
function budgeted(budget: number): void {
  fx.calls = [];
  fx.beforeCall = (call) => {
    if (call > budget) throw new ExactBudgetExhaustedError("x");
  };
}

const item = (i: number, over: Partial<FakeItem> = {}): FakeItem => ({
  n: i,
  account: 1,
  name: "Acme BV",
  amount: 10 + (i % 90),
  currency: "EUR",
  invoiceNumber: i,
  ts: 1000 + i,
  ...over,
});
const many = (count: number, from = 1000): FakeItem[] =>
  Array.from({ length: count }, (_, i) => item(from + i));

const status = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await db
        .prepare("SELECT exact_id, status FROM open_items WHERE division_id = ?1")
        .bind(div.id)
        .all<{ exact_id: string; status: string }>()
    ).results.map((r) => [r.exact_id, r.status]),
  );
const count = async (where = "1 = 1"): Promise<number> =>
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM open_items WHERE division_id = ?1 AND ${where}`)
      .bind(div.id)
      .first<{ n: number }>()
  )?.n ?? 0;
const state = (entity: string) =>
  db
    .prepare("SELECT * FROM sync_state WHERE division_id = ?1 AND entity = ?2")
    .bind(div.id, entity)
    .first<{
      cursor: string;
      last_status: string | null;
      last_error: string | null;
      pass_token: string | null;
      pass_rows: number;
      pass_total: number | null;
      pass_cycle: number | null;
      done_cycle: number | null;
      cycle_seq: number | null;
      cycle_started_at: string | null;
      retry_count: number;
      retry_day: string | null;
      last_full_completed_at: string | null;
    }>();
const skiptokens = (path: string): (string | undefined)[] =>
  fx.calls.filter((c) => c.path === path).map((c) => c.query?.["$skiptoken"]);

describe.each([
  { label: "list pages of 60", total: 300, listSize: 60, chunk: 1, perRun: 3 },
  { label: "list pages of 1,000", total: 2500, listSize: 1000, chunk: 1, perRun: 2 },
])("resumable FULL read of open receivables with $label", ({ total, listSize, chunk, perRun }) => {
  it("closes only when the last page was read, however many runs it takes", async () => {
    fx.listPageSize = listSize;
    fx.syncPageSize = 1000;
    fx.accounts = [{ n: 1, name: "Acme BV", ts: 5, customer: true }];
    fx.receivables = many(total);
    expect((await run("full")).status).toBe("ok");
    expect(await count("status = 'open'")).toBe(total);

    // One item is paid in Exact; the next full pass has to find that out, but only at its end.
    const gone = fx.receivables.splice(7, 1)[0] as FakeItem;
    let runs = 0;
    let finished: SyncSummary | null = null;
    let lastRead = 0;
    while (finished === null && runs < 30) {
      runs++;
      budgeted(perRun); // divisions + (perRun - 1) pages of this entity per run
      const s = await run("full", { chunkPages: chunk });
      const r = s.entities.receivables;
      if (r.status === "ok") {
        finished = s;
        break;
      }
      // A partial run closes nothing, saves a $skiptoken and moves forward.
      expect(s.status).toBe("partial");
      expect(r.status).toBe("partial");
      expect(r.closed).toBeUndefined();
      expect(r.progress?.read ?? 0).toBeGreaterThan(lastRead);
      lastRead = r.progress?.read ?? 0;
      expect((await status())[guid(gone.n)]).toBe("open");
      expect((await state("receivables"))?.pass_token).toBeTruthy();
      expect((await state("receivables"))?.pass_rows).toBe(lastRead);
    }
    expect(finished).not.toBeNull();
    expect(runs).toBeGreaterThanOrEqual(3); // forced to resume at least twice
    expect(finished?.entities.receivables.closed).toBe(1);
    expect((await status())[guid(gone.n)]).toBe("closed");
    expect(await count("status = 'open'")).toBe(total - 1);
    // Every later run resumed from the saved token instead of the start of the list.
    expect(state("receivables")).resolves.toMatchObject({ pass_token: null });
  });

  it("resumes with the saved $skiptoken and does not re-read what it already has", async () => {
    fx.listPageSize = listSize;
    fx.receivables = many(total);
    budgeted(perRun);
    const first = await run("full", { chunkPages: chunk });
    expect(first.entities.receivables.status).toBe("partial");
    const firstTokens = skiptokens("/read/financial/ReceivablesList");
    expect(firstTokens[0]).toBeUndefined(); // from the start
    const saved = (await state("receivables"))?.pass_token;
    expect(saved).toBeTruthy();

    budgeted(perRun);
    await run("full", { chunkPages: chunk });
    expect(skiptokens("/read/financial/ReceivablesList")[0]).toBe(saved);
  });
});

describe("full cycles", () => {
  const seedTwoKinds = () => {
    fx.listPageSize = 60;
    fx.syncPageSize = 1000;
    fx.accounts = [{ n: 1, name: "Acme BV", ts: 5, customer: true }];
    fx.receivables = many(130, 1000);
    fx.payables = many(70, 5000);
  };

  it("runs the entities in order: divisions, receivables, payables, relations, ibans", async () => {
    seedTwoKinds();
    fx.banks = [{ n: 1, account: 1, iban: "NL91ABNA0417164300" }];
    await run("full");
    const firstPaths = fx.calls.map((c) => c.path).filter((p, i, a) => a.indexOf(p) === i);
    expect(firstPaths).toEqual([
      "/system/Divisions",
      "/read/financial/ReceivablesList",
      "/read/financial/PayablesList",
      "/sync/CRM/Accounts",
      "/crm/BankAccounts",
    ]);
  });

  it("does not repeat finished entities in later runs of the same cycle", async () => {
    seedTwoKinds();
    budgeted(5); // divisions + 3 receivables pages + 1 payables page: stops in payables
    const a = await run("full");
    expect(a.status).toBe("partial");
    expect(a.entities.receivables.status).toBe("ok");
    expect(a.entities.payables.status).toBe("partial");
    expect(a.cycleComplete).toBe(false);

    budgeted(50);
    const b = await run("full");
    expect(b.entities.receivables.status).toBe("skipped");
    expect(b.entities.receivables.cycleDone).toBe(true);
    expect(fx.calls.some((c) => c.path === "/read/financial/ReceivablesList")).toBe(false);
    expect(b.status).toBe("ok");
    expect(b.cycleComplete).toBe(true);
    expect((await state("run"))?.cycle_seq).toBeNull();
    expect((await state("run"))?.last_full_completed_at).not.toBeNull();

    // The cycle is over: the next full run starts a new pass from the top.
    fx.calls = [];
    await run("full");
    expect(skiptokens("/read/financial/ReceivablesList")[0]).toBeUndefined();
    expect(fx.calls.filter((c) => c.path === "/read/financial/ReceivablesList").length).toBe(3);
  });

  it("restart abandons the open cycle; so does a cycle older than 36 hours", async () => {
    seedTwoKinds();
    budgeted(3);
    await run("full");
    const cycle1 = (await state("run"))?.cycle_seq;
    expect(cycle1).not.toBeNull();
    expect((await state("receivables"))?.pass_token).toBeTruthy();

    budgeted(2);
    await run("full", { restart: true });
    expect(skiptokens("/read/financial/ReceivablesList")[0]).toBeUndefined();
    const cycle2 = (await state("run"))?.cycle_seq;
    expect(cycle2).toBeGreaterThan(cycle1 as number);

    // Within 36 h the next run continues cycle 2 ...
    clock += CYCLE_MAX_AGE_MS - 60_000;
    budgeted(2);
    await run("full");
    expect(skiptokens("/read/financial/ReceivablesList")[0]).toBeTruthy();
    expect((await state("run"))?.cycle_seq).toBe(cycle2);
    // ... after that it begins again from the top.
    clock += 120_000;
    budgeted(2);
    await run("full");
    expect(skiptokens("/read/financial/ReceivablesList")[0]).toBeUndefined();
    expect((await state("run"))?.cycle_seq).toBeGreaterThan(cycle2 as number);
  });

  it("an hourly incremental run between slices does not break the pass or close anything", async () => {
    seedTwoKinds();
    await run("full"); // everything known
    fx.receivables = fx.receivables.slice(0, 110); // 20 look paid; the pass will find them
    budgeted(2); // divisions + one receivables page (60)
    const slice = await run("full");
    expect(slice.entities.receivables.status).toBe("partial");
    budgeted(30);
    const inc = await run("incremental");
    expect(inc.status).toBe("ok");
    expect(await count("status = 'closed'")).toBe(0);
    budgeted(30);
    const rest = await run("full");
    expect(rest.entities.receivables.status).toBe("ok");
    expect(rest.entities.receivables.progress?.read).toBe(110);
    expect(rest.entities.receivables.closed).toBe(20);
  });

  it("incremental runs and runs with readIbans false never read crm/BankAccounts", async () => {
    seedTwoKinds();
    fx.banks = [{ n: 1, account: 1, iban: "NL91ABNA0417164300" }];
    await run("incremental");
    await run("full", { readIbans: false });
    expect(fx.calls.some((c) => c.path === "/crm/BankAccounts")).toBe(false);
    const manual = await run("full", { readIbans: false });
    expect(manual.entities.bank_accounts.status).toBe("skipped");
    // A manual full run that read everything else is not the night's complete full sync.
    expect((await state("run"))?.last_full_completed_at).toBeNull();
    expect(manual.cycleComplete).toBe(true);
    const nightly = await run("full");
    expect(fx.calls.some((c) => c.path === "/crm/BankAccounts")).toBe(true);
    expect(nightly.entities.bank_accounts.status).toBe("ok");
    expect((await state("run"))?.last_full_completed_at).not.toBeNull();
  });
});

describe("forward progress under a deadline", () => {
  it("each slice reads at least one page even when the deadline has already passed", async () => {
    fx.listPageSize = 60;
    fx.receivables = many(200);
    let readBefore = 0;
    let slices = 0;
    let last: SyncSummary | null = null;
    while (slices < 10) {
      slices++;
      const s = await run("full", {
        deadlineMs: clock - 1,
        guaranteeProgress: true,
        chunkPages: 1,
        readIbans: false,
      });
      last = s;
      const read = s.entities.receivables.progress?.read ?? 0;
      if (s.entities.receivables.status === "ok") break;
      expect(s.status).toBe("partial");
      expect(s.entities.receivables.error).toBe("time_limit");
      expect(read).toBeGreaterThan(readBefore);
      readBefore = read;
    }
    expect(last?.entities.receivables.status).toBe("ok");
    expect(slices).toBe(4); // 200 rows at 60 per page, one page per slice
    expect(await count("status = 'open'")).toBe(200);
  });

  it("without the guarantee a deadline in the past reads nothing", async () => {
    fx.receivables = many(5);
    const s = await run("full", { deadlineMs: clock - 1 });
    expect(s.status).toBe("partial");
    expect(fx.calls).toHaveLength(0);
  });

  it("keeps the pages read before a mid-chunk stop (no lost chunk)", async () => {
    fx.listPageSize = 60;
    fx.receivables = many(300);
    fx.calls = [];
    fx.beforeCall = (call) => {
      if (call === 4) throw new ExactRateLimitedError(30_000); // divisions, page 1, page 2, page 3 dies
    };
    const s = await run("full"); // chunk of 5 pages
    expect(s.entities.receivables).toMatchObject({ status: "partial", error: "rate_limited" });
    expect(s.entities.receivables.progress?.read).toBe(120);
    expect(await count()).toBe(120);
    expect((await state("receivables"))?.pass_rows).toBe(120);
  });
});

describe("incremental sync does not import history (B1e)", () => {
  it("inserts open items only, but updates a known item that has since been paid", async () => {
    fx.receivables = [
      item(1),
      item(2, { amount: 0, fullyPaid: true }),
      item(3, { amount: 0, fullyPaid: true }),
      item(4),
    ];
    const s = await run("incremental");
    expect(s.status).toBe("ok");
    expect(Object.keys(await status()).sort()).toEqual([guid(1), guid(4)]);

    // Item 1 is paid later: the known row is updated to closed, still no history rows.
    fx.receivables = [
      item(1, { amount: 0, fullyPaid: true, ts: 2000 }),
      item(5, { amount: 0, fullyPaid: true, ts: 2001 }),
    ];
    await run("incremental");
    expect(await status()).toEqual({ [guid(1)]: "closed", [guid(4)]: "open" });
  });
});

describe("transient failures (S3)", () => {
  const failFirstEntityCall = (err: () => Error): void => {
    fx.calls = [];
    fx.beforeCall = (_c, req) => {
      if (req.path === "/read/financial/ReceivablesList") throw err();
    };
  };

  it.each([
    ["502", () => new ExactApiError(502, "x")],
    ["503", () => new ExactApiError(503, "x")],
    ["504", () => new ExactApiError(504, "x")],
    ["network", () => new ExactApiError(502, "x", "network")],
    ["gate_unavailable", () => new ExactApiError(503, "x", "gate_unavailable")],
    ["rate limit", () => new ExactRateLimitedError(1000)],
  ])(
    "%s ends the run as partial and stops, without touching the other entities",
    async (_n, err) => {
      fx.receivables = many(3);
      failFirstEntityCall(err);
      const s = await run("full");
      expect(s.status).toBe("partial");
      expect(s.entities.receivables.status).toBe("partial");
      expect(s.entities.payables.status).toBe("skipped");
      expect(s.entities.relations.status).toBe("skipped");
      expect((await state("run"))?.retry_count).toBe(1);
      expect(await count()).toBe(0);
    },
  );

  it("a permanent error stays an error, counts no retry and lets the next entities run", async () => {
    fx.receivables = many(3);
    failFirstEntityCall(() => new ExactApiError(400, "x"));
    const s = await run("full");
    expect(s.status).toBe("error");
    expect(s.entities.payables.status).toBe("ok");
    expect((await state("run"))?.retry_count).toBe(0);
  });

  it("is bounded: after MAX_TRANSIENT_RETRIES it becomes an error, and a new day starts again", async () => {
    fx.receivables = many(3);
    failFirstEntityCall(() => new ExactApiError(503, "x"));
    const seen: string[] = [];
    for (let i = 0; i < MAX_TRANSIENT_RETRIES + 2; i++) {
      seen.push((await run("full")).status);
    }
    expect(seen).toEqual([
      ...Array<string>(MAX_TRANSIENT_RETRIES).fill("partial"),
      "error",
      "error",
    ]);
    expect((await state("run"))?.retry_count).toBe(MAX_TRANSIENT_RETRIES + 2);
    expect((await state("receivables"))?.last_status).toBe("error");

    clock += 24 * 3_600_000;
    expect((await run("full")).status).toBe("partial");
    expect((await state("run"))?.retry_count).toBe(1);
  });

  it("a successful run does not hide earlier failures of the day", async () => {
    fx.receivables = many(3);
    failFirstEntityCall(() => new ExactApiError(503, "x"));
    await run("full");
    fx.beforeCall = () => undefined;
    await run("full");
    expect((await state("run"))?.retry_count).toBe(1);
  });
});

describe("close guard (S5)", () => {
  it("allows closing up to max(5, 20 % of the open items)", () => {
    expect(CLOSE_GUARD_MIN).toBe(5);
    expect(CLOSE_GUARD_FRACTION).toBe(0.2);
    // few open items: the floor of 5 applies
    expect(closeAllowed(0, 0)).toBe(true);
    expect(closeAllowed(5, 10)).toBe(true);
    expect(closeAllowed(6, 10)).toBe(false);
    expect(closeAllowed(5, 5)).toBe(true);
    // many open items: 20 %
    expect(closeAllowed(20, 100)).toBe(true);
    expect(closeAllowed(21, 100)).toBe(false);
    expect(closeAllowed(1000, 5000)).toBe(true);
    expect(closeAllowed(1001, 5000)).toBe(false);
  });

  const setup = async (open: number, drop: number) => {
    fx.listPageSize = 60;
    fx.receivables = many(open);
    await run("full");
    fx.receivables = fx.receivables.slice(drop);
  };

  it("closes exactly 20 of 100 but refuses 21 of 100 without the override", async () => {
    await setup(100, 20);
    const ok = await run("full");
    expect(ok.entities.receivables).toMatchObject({ status: "ok", closed: 20 });

    await resetSync();
    div = await addDivision();
    fx = new FakeExact(div.exactDivision);
    fx.divisions = [{ code: div.exactDivision, description: "BV" }];
    await setup(100, 21);
    const refused = await run("full");
    expect(refused.status).toBe("error");
    expect(refused.entities.receivables).toMatchObject({ status: "error", error: "close_guard" });
    expect(await count("status = 'closed'")).toBe(0);
    expect((await state("run"))?.last_error).toBe("close_guard");

    // An admin can confirm; the cycle re-reads the list and closes with the override.
    const forced = await run("full", { allowLargeClose: true });
    expect(forced.entities.receivables).toMatchObject({ status: "ok", closed: 21 });
  });

  it("holds for a small division: 5 of 10 close, 6 of 10 do not", async () => {
    await setup(10, 5);
    expect((await run("full")).entities.receivables.closed).toBe(5);
    await resetSync();
    div = await addDivision();
    fx = new FakeExact(div.exactDivision);
    fx.divisions = [{ code: div.exactDivision, description: "BV" }];
    await setup(10, 6);
    expect((await run("full")).entities.receivables.error).toBe("close_guard");
  });

  it("applies when the read took several runs", async () => {
    await setup(100, 30);
    budgeted(2);
    expect((await run("full", { chunkPages: 1 })).status).toBe("partial");
    fx.beforeCall = () => undefined;
    const done = await run("full", { chunkPages: 1 });
    expect(done.entities.receivables.error).toBe("close_guard");
    expect(await count("status = 'closed'")).toBe(0);
  });
});

describe("stale saved token", () => {
  it("a permanent error while resuming drops the token so it is not retried for 36 hours", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fx.listPageSize = 60;
    fx.receivables = many(200);
    budgeted(2);
    await run("full", { chunkPages: 1 });
    expect((await state("receivables"))?.pass_token).toBeTruthy();
    fx.calls = [];
    fx.beforeCall = (_c, req) => {
      if (req.path === "/read/financial/ReceivablesList") throw new ExactApiError(400, "x");
    };
    const s = await run("full");
    expect(s.entities.receivables.status).toBe("error");
    expect((await state("receivables"))?.pass_token).toBeNull();
    fx.beforeCall = () => undefined;
    fx.calls = [];
    await run("full");
    expect(skiptokens("/read/financial/ReceivablesList")[0]).toBeUndefined();
  });
});
