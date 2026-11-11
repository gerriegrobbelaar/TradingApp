/**
 * Review G3 (phase 2 fixes S4, S7, S8): relation bank accounts, incremental open items off by
 * default, division scope and base currency.
 */
import { env } from "cloudflare:test";
import type { ExactTransport } from "@camelthorn/exact";
import { beforeEach, describe, expect, it } from "vitest";
import { callExact, divisionsOf } from "./job-helpers";
import {
  INCREMENTAL_OPEN_ITEMS_KEY,
  SYNC_ENTITIES,
  isSyncEntity,
  readBoolSetting,
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
} from "./sync-helpers";

const ACTOR = "approver@camelthorncapital.com";
const NL = "NL91ABNA0417164300";
const DE = "DE89370400440532013000";
const GB = "GB82WEST12345698765432";
const BE = "BE68539007547034";

let div: DivisionRef & { name: string };
let fx: FakeExact;
let gate: FakeGate;
let n = 0;

beforeEach(async () => {
  await resetSync();
  div = await addDivision();
  fx = new FakeExact(div.exactDivision);
  fx.divisions = [{ code: div.exactDivision, description: "BV" }];
  gate = fakeGate();
});

const run = (mode: SyncMode, over: Partial<SyncOptions> = {}): Promise<SyncSummary> =>
  syncDivision(
    env,
    div,
    { jobId: `g3-${++n}`, mode, actor: ACTOR, ...over },
    { transport: fx.transport, gate },
  );

describe("sync entity names (S9)", () => {
  it("has one list, with relation_ibans and without bank_accounts", () => {
    expect([...SYNC_ENTITIES].sort()).toEqual(
      [
        "divisions",
        "gl_accounts",
        "gl_balances",
        "gl_budgets",
        "payables",
        "receivables",
        "relation_ibans",
        "relations",
        "run",
      ].sort(),
    );
    expect(isSyncEntity("relation_ibans")).toBe(true);
    expect(isSyncEntity("bank_accounts")).toBe(false);
    expect(isSyncEntity("nonsense")).toBe(false);
  });

  it("writes the IBAN pass under relation_ibans", async () => {
    fx.accounts = [{ n: 1, name: "S", ts: 10, supplier: true }];
    await run("full");
    const names = (
      await db
        .prepare("SELECT entity FROM sync_state WHERE division_id = ?1 ORDER BY entity")
        .bind(div.id)
        .all<{ entity: string }>()
    ).results.map((r) => r.entity);
    expect(names).toContain("relation_ibans");
    expect(names).not.toContain("bank_accounts");
  });
});

describe("relation bank accounts (S8)", () => {
  const relation = () =>
    db
      .prepare(
        "SELECT id, iban, iban_changed_at, iban_added_at FROM relations WHERE division_id = ?1 AND exact_id = ?2",
      )
      .bind(div.id, guid(2))
      .first<{
        id: number;
        iban: string | null;
        iban_changed_at: string | null;
        iban_added_at: string | null;
      }>();
  const accounts = async () =>
    (
      await db
        .prepare(
          `SELECT iban, is_main, removed_at IS NOT NULL AS removed, first_seen_at, last_seen_at
           FROM relation_bank_accounts WHERE division_id = ?1 ORDER BY iban`,
        )
        .bind(div.id)
        .all<{
          iban: string;
          is_main: number;
          removed: number;
          first_seen_at: string;
          last_seen_at: string;
        }>()
    ).results;
  const audits = async (action: string) => auditRows(action, `${div.id}:${guid(2)}`);

  beforeEach(() => {
    fx.accounts = [
      { n: 1, name: "Acme", ts: 10, customer: true },
      { n: 2, name: "Supplier One", ts: 20, supplier: true },
    ];
  });

  it("stores every account of a relation, normalised, and shows the main one", async () => {
    fx.banks = [
      { n: 1, account: 2, iban: "de89 3704 0044 0532 0130 00", main: false },
      { n: 2, account: 2, iban: NL, main: true },
      { n: 3, account: 2, iban: "nl91abna0417164300", main: true }, // the same IBAN again
      { n: 4, account: 2, iban: "not an iban", main: false },
      { n: 5, account: 2, iban: null },
      { n: 6, account: 999, iban: GB }, // unknown relation: skipped
    ];
    await run("full");
    expect((await relation())?.iban).toBe(NL);
    expect((await accounts()).map((a) => [a.iban, a.is_main, a.removed])).toEqual([
      [DE, 0, 0],
      [NL, 1, 0],
    ]);
    // The first pass is the baseline: nothing flagged, nothing audited.
    expect(await relation()).toMatchObject({ iban_changed_at: null, iban_added_at: null });
    expect(await audits("relation.iban_added")).toHaveLength(0);
    expect(await audits("relation.iban_changed")).toHaveLength(0);
  });

  it("flags a second, non-main account as ADDED (not changed) with a masked audit row", async () => {
    fx.banks = [{ n: 1, account: 2, iban: NL, main: true }];
    await run("full");
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 2, iban: DE, main: false },
    ];
    await run("full");
    const rel = await relation();
    expect(rel?.iban).toBe(NL);
    expect(rel?.iban_added_at).not.toBeNull();
    expect(rel?.iban_changed_at).toBeNull();
    const added = await audits("relation.iban_added");
    expect(added).toHaveLength(1);
    expect(added[0]?.actor_email).toBe(ACTOR);
    expect(added[0]?.after_json).toBe('{"iban":"DE89****3000"}');
    expect(added[0]?.after_json).not.toContain("0532");
    expect(await audits("relation.iban_changed")).toHaveLength(0);

    await run("full"); // again: nothing new
    expect(await audits("relation.iban_added")).toHaveLength(1);
  });

  it("does not flag a reordered answer, or a different case and spacing", async () => {
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 2, iban: DE, main: false },
    ];
    await run("full");
    const first = await accounts();
    fx.banks = [
      { n: 2, account: 2, iban: "de89 3704 0044 0532 0130 00", main: false },
      { n: 1, account: 2, iban: "nl91 abna 0417 1643 00", main: true },
    ];
    await run("full");
    expect(await relation()).toMatchObject({
      iban: NL,
      iban_changed_at: null,
      iban_added_at: null,
    });
    expect((await audits("relation.iban_added")).length).toBe(0);
    expect((await audits("relation.iban_changed")).length).toBe(0);
    const again = await accounts();
    expect(again.map((a) => a.iban)).toEqual(first.map((a) => a.iban));
    // last_seen_at moves with every complete read, first_seen_at does not
    expect(again.every((a, i) => a.first_seen_at === first[i]?.first_seen_at)).toBe(true);
    expect(again.every((a, i) => a.last_seen_at >= (first[i]?.last_seen_at ?? ""))).toBe(true);
  });

  it("without a main account the display IBAN is the lowest; a new lower IBAN is an addition only", async () => {
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: false },
      { n: 2, account: 2, iban: DE, main: false },
    ];
    await run("full");
    expect((await relation())?.iban).toBe(DE); // lowest of DE.. and NL..
    fx.banks = [...fx.banks, { n: 3, account: 2, iban: BE, main: false }];
    await run("full");
    const rel = await relation();
    expect(rel?.iban).toBe(BE); // the new lowest now shows
    expect(rel?.iban_added_at).not.toBeNull();
    expect(rel?.iban_changed_at).toBeNull(); // 'lowest' flipping is not a main-account change
    expect(await audits("relation.iban_changed")).toHaveLength(0);
    expect(await audits("relation.iban_added")).toHaveLength(1);
  });

  it("flags a CHANGE when the main account moves, with masked before and after", async () => {
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 2, iban: DE, main: false },
    ];
    await run("full");
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: false },
      { n: 2, account: 2, iban: DE, main: true },
    ];
    await run("full");
    expect(await relation()).toMatchObject({ iban: DE });
    expect((await relation())?.iban_changed_at).not.toBeNull();
    expect((await relation())?.iban_added_at).toBeNull(); // nothing new in the set
    const rows = await audits("relation.iban_changed");
    expect(rows).toHaveLength(1);
    expect(`${rows[0]?.before_json} ${rows[0]?.after_json}`).toBe(
      '{"iban":"NL91****4300"} {"iban":"DE89****3000"}',
    );
  });

  it("removes only on a complete read, keeps the row, and counts a comeback as an addition", async () => {
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 2, iban: DE, main: false },
    ];
    await run("full");
    // The non-main account is deleted in Exact.
    fx.banks = [{ n: 1, account: 2, iban: NL, main: true }];
    await run("full");
    expect((await accounts()).map((a) => [a.iban, a.removed])).toEqual([
      [DE, 1],
      [NL, 0],
    ]);
    expect(await relation()).toMatchObject({
      iban: NL,
      iban_changed_at: null,
      iban_added_at: null,
    });

    // It comes back: a new IBAN in the active set again.
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 2, iban: DE, main: false },
    ];
    await run("full");
    expect((await accounts()).map((a) => [a.iban, a.removed])).toEqual([
      [DE, 0],
      [NL, 0],
    ]);
    expect((await relation())?.iban_added_at).not.toBeNull();
    expect(await audits("relation.iban_added")).toHaveLength(1);
  });

  it("a removed MAIN account counts as a main change when the display IBAN moves", async () => {
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 2, iban: DE, main: false },
    ];
    await run("full");
    fx.banks = [{ n: 2, account: 2, iban: DE, main: false }];
    await run("full");
    expect(await relation()).toMatchObject({ iban: DE });
    expect((await relation())?.iban_changed_at).not.toBeNull();
    expect((await relation())?.iban_added_at).toBeNull();
  });

  it("an answer with no bank account at all removes nothing", async () => {
    fx.banks = [{ n: 1, account: 2, iban: NL, main: true }];
    await run("full");
    fx.banks = [];
    const s = await run("full");
    expect(s.entities.relation_ibans.status).toBe("ok");
    expect((await accounts()).map((a) => a.removed)).toEqual([0]);
    expect((await relation())?.iban).toBe(NL);
  });

  it("a relation that loses all its accounts keeps its last IBAN; the rows are marked removed", async () => {
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 1, iban: DE, main: true },
    ];
    await run("full");
    fx.banks = [{ n: 2, account: 1, iban: DE, main: true }];
    await run("full");
    expect((await relation())?.iban).toBe(NL);
    expect((await accounts()).map((a) => [a.iban, a.removed])).toEqual([
      [DE, 0],
      [NL, 1],
    ]);
  });

  it("flags a first IBAN on a relation we already knew, and a brand-new relation with one", async () => {
    await run("full"); // IBAN pass completes with nothing
    fx.accounts.push({ n: 3, name: "New supplier", ts: 30, supplier: true });
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 3, iban: DE, main: true },
    ];
    await run("full");
    const flagged = await db
      .prepare(
        "SELECT exact_id FROM relations WHERE division_id = ?1 AND iban_added_at IS NOT NULL AND iban_changed_at IS NOT NULL ORDER BY exact_id",
      )
      .bind(div.id)
      .all<{ exact_id: string }>();
    expect(flagged.results.map((r) => r.exact_id)).toEqual([guid(2), guid(3)]);
    const changed = await audits("relation.iban_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.before_json).toBe('{"iban":null}');
  });

  it("treats the one IBAN of a relation from before migration 0007 (IBAN, no rows) as its baseline", async () => {
    fx.banks = [{ n: 1, account: 2, iban: NL, main: true }];
    await run("full");
    // Simulate the pre-0007 state: relations.iban set, no relation_bank_accounts rows.
    await db.prepare("DELETE FROM relation_bank_accounts").run();
    await run("full");
    expect(await relation()).toMatchObject({
      iban: NL,
      iban_changed_at: null,
      iban_added_at: null,
    });
    expect(await accounts()).toHaveLength(1);
    expect(await audits("relation.iban_added")).toHaveLength(0);
  });

  it("a legacy relation with ANOTHER IBAN next to its old one flags that one as added", async () => {
    fx.banks = [{ n: 1, account: 2, iban: NL, main: true }];
    await run("full");
    await db.prepare("DELETE FROM relation_bank_accounts").run();
    // Between the last pre-0007 pass and the first one after it, a second account appeared.
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 2, iban: GB, main: false },
    ];
    await run("full");
    expect(await relation()).toMatchObject({ iban: NL, iban_changed_at: null });
    expect((await relation())?.iban_added_at).not.toBeNull();
    const added = await audits("relation.iban_added");
    expect(added.map((a) => a.after_json)).toEqual(['{"iban":"GB82****5432"}']);
  });

  it("a legacy relation whose display IBAN differs is a change", async () => {
    fx.banks = [{ n: 1, account: 2, iban: NL, main: true }];
    await run("full");
    await db.prepare("DELETE FROM relation_bank_accounts").run();
    fx.banks = [{ n: 2, account: 2, iban: DE, main: true }];
    await run("full");
    expect((await relation())?.iban_changed_at).not.toBeNull();
    expect((await relation())?.iban_added_at).not.toBeNull();
  });

  it("a swap in one read (old IBAN gone, new one there) flags added AND changed, with or without main", async () => {
    // Relation 2 uses main accounts, relation 1 none.
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 1, iban: DE, main: false },
    ];
    await run("full");
    fx.banks = [
      { n: 3, account: 2, iban: GB, main: true },
      { n: 4, account: 1, iban: BE, main: false },
    ];
    await run("full");
    for (const [acct, before, after] of [
      [2, "NL91****4300", "GB82****5432"],
      [1, "DE89****3000", "BE68****7034"],
    ] as const) {
      const rel = await db
        .prepare(
          "SELECT iban_added_at, iban_changed_at FROM relations WHERE division_id = ?1 AND exact_id = ?2",
        )
        .bind(div.id, guid(acct))
        .first<{ iban_added_at: string | null; iban_changed_at: string | null }>();
      expect(rel?.iban_added_at).not.toBeNull();
      expect(rel?.iban_changed_at).not.toBeNull();
      const changed = await auditRows("relation.iban_changed", `${div.id}:${guid(acct)}`);
      expect(changed.map((c) => `${c.before_json} ${c.after_json}`)).toEqual([
        `{"iban":"${before}"} {"iban":"${after}"}`,
      ]);
      expect(await auditRows("relation.iban_added", `${div.id}:${guid(acct)}`)).toHaveLength(1);
    }
  });

  it("invisible and full-width characters do not make a known IBAN new", async () => {
    fx.banks = [{ n: 1, account: 2, iban: NL, main: true }];
    await run("full");
    fx.banks = [{ n: 1, account: 2, iban: "NL91\u00a0ABNA\u200b0417 1643 ００", main: true }];
    await run("full");
    expect(await relation()).toMatchObject({
      iban: NL,
      iban_added_at: null,
      iban_changed_at: null,
    });
    expect((await accounts()).map((a) => a.iban)).toEqual([NL]);
  });

  it("a new IBAN with a wrong check digit is still stored and flagged (never ignored)", async () => {
    fx.banks = [{ n: 1, account: 2, iban: NL, main: true }];
    await run("full");
    const bad = "NL00ABNA0417164300"; // fails mod-97
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 2, iban: bad, main: false },
    ];
    await run("full");
    expect((await accounts()).map((a) => a.iban)).toEqual([bad, NL]);
    expect((await relation())?.iban_added_at).not.toBeNull();
  });

  it("writes nothing when the sync lease was lost during the IBAN pass", async () => {
    fx.banks = [{ n: 1, account: 2, iban: NL, main: true }];
    await run("full");
    fx.banks = [
      { n: 1, account: 2, iban: NL, main: true },
      { n: 2, account: 2, iban: DE, main: false },
    ];
    // Another run takes the division's lease while this run reads the bank accounts.
    const transport: ExactTransport = async (req) => {
      const res = await fx.transport(req);
      if (req.path === "/crm/BankAccounts") {
        await db
          .prepare("UPDATE sync_locks SET holder = 'someone-else', run_seq = run_seq + 1")
          .run();
      }
      return res;
    };
    await syncDivision(
      env,
      div,
      { jobId: "lost-lease", mode: "full", actor: ACTOR },
      { transport, gate },
    );
    expect((await accounts()).map((a) => a.iban)).toEqual([NL]);
    expect(await audits("relation.iban_added")).toHaveLength(0);
  });
});

describe("incremental open items are off by default (S4)", () => {
  const seed = () => {
    fx.accounts = [{ n: 1, name: "Acme", ts: 10, customer: true }];
    fx.receivables = [
      { n: 101, account: 1, name: "Acme", amount: 10, currency: "EUR", invoiceNumber: 1, ts: 100 },
    ];
    fx.payables = [
      { n: 201, account: 1, name: "Acme", amount: 20, currency: "EUR", invoiceNumber: 2, ts: 200 },
    ];
  };
  const sources = async () =>
    (
      await db
        .prepare("SELECT exact_id, source FROM open_items WHERE division_id = ?1 ORDER BY exact_id")
        .bind(div.id)
        .all<{ exact_id: string; source: string | null }>()
    ).results;

  it("an incremental run refreshes only divisions and relations when the setting is off", async () => {
    await db.prepare("DELETE FROM settings WHERE key = ?1").bind(INCREMENTAL_OPEN_ITEMS_KEY).run();
    seed();
    const s = await run("incremental");
    expect(s.status).toBe("ok");
    expect(s.entities.receivables.status).toBe("skipped");
    expect(s.entities.payables.status).toBe("skipped");
    expect(s.entities.relations.status).toBe("ok");
    expect(fx.pathsCalled().sort()).toEqual(["/sync/CRM/Accounts", "/system/Divisions"]);
    expect(await sources()).toEqual([]);
  });

  it("the nightly full pass reads the lists and marks the rows source 'list'", async () => {
    await db.prepare("DELETE FROM settings WHERE key = ?1").bind(INCREMENTAL_OPEN_ITEMS_KEY).run();
    seed();
    const s = await run("full");
    expect(s.status).toBe("ok");
    expect(fx.pathsCalled()).toContain("/read/financial/ReceivablesList");
    expect(fx.pathsCalled()).not.toContain("/sync/Cashflow/Receivables");
    expect((await sources()).map((r) => r.source)).toEqual(["list", "list"]);
  });

  it("with the setting on, incremental runs read the sync endpoints (source 'sync')", async () => {
    seed();
    const s = await run("incremental");
    expect(s.entities.receivables.status).toBe("ok");
    expect(fx.pathsCalled()).toContain("/sync/Cashflow/Receivables");
    expect((await sources()).map((r) => r.source)).toEqual(["sync", "sync"]);
  });

  it("an explicit option beats the stored setting", async () => {
    seed();
    const s = await run("incremental", { incrementalOpenItems: false });
    expect(s.entities.receivables.status).toBe("skipped");
    await db.prepare("DELETE FROM settings WHERE key = ?1").bind(INCREMENTAL_OPEN_ITEMS_KEY).run();
    const t = await run("incremental", { incrementalOpenItems: true });
    expect(t.entities.receivables.status).toBe("ok");
  });

  it("reads the setting as false unless it is the JSON boolean true", async () => {
    const set = (v: string) =>
      db
        .prepare(
          `INSERT INTO settings (key, value_json) VALUES (?1, ?2)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
        )
        .bind(INCREMENTAL_OPEN_ITEMS_KEY, v)
        .run();
    for (const v of ["true", " true "]) {
      await set(v);
      expect(await readBoolSetting(db, INCREMENTAL_OPEN_ITEMS_KEY, false)).toBe(true);
    }
    for (const v of ["false", '"true"', "1", "null", "{", ""]) {
      await set(v);
      expect(await readBoolSetting(db, INCREMENTAL_OPEN_ITEMS_KEY, false)).toBe(false);
    }
    await db.prepare("DELETE FROM settings WHERE key = ?1").bind(INCREMENTAL_OPEN_ITEMS_KEY).run();
    expect(await readBoolSetting(db, INCREMENTAL_OPEN_ITEMS_KEY, false)).toBe(false);
    expect(await readBoolSetting(db, INCREMENTAL_OPEN_ITEMS_KEY, true)).toBe(true);
  });

  it("the hourly scheduled tick is cheap: divisions and relations only", async () => {
    await db.prepare("DELETE FROM settings WHERE key = ?1").bind(INCREMENTAL_OPEN_ITEMS_KEY).run();
    seed();
    const r = await callExact("incremental", Date.parse("2026-07-15T10:00:00Z"), {
      transport: fx.transport,
      gate,
    });
    expect(divisionsOf(r)).toEqual([{ id: div.id, status: "ok" }]);
    expect(fx.pathsCalled().sort()).toEqual(["/sync/CRM/Accounts", "/system/Divisions"]);
  });
});

describe("which divisions sync, and in which currency (S7)", () => {
  it("the scheduler only syncs enabled divisions", async () => {
    const other = await db
      .prepare(
        "INSERT INTO divisions (connection_id, exact_division, name, sync_enabled) VALUES (?1, ?2, 'Off', 0)",
      )
      .bind(div.connectionId, div.exactDivision + 1)
      .run();
    const deps = { transport: fx.transport, gate };
    const t1 = await callExact("incremental", Date.parse("2026-07-15T10:00:00Z"), deps);
    expect(divisionsOf(t1).map((x) => x.id)).toEqual([div.id]);
    await db
      .prepare("UPDATE divisions SET sync_enabled = 1 WHERE id = ?1")
      .bind(other.meta.last_row_id)
      .run();
    const t2 = await callExact("incremental", Date.parse("2026-07-15T11:00:00Z"), deps);
    expect(
      divisionsOf(t2)
        .map((x) => x.id)
        .sort(),
    ).toEqual([div.id, other.meta.last_row_id].sort());
  });

  it("a division list read adds other divisions DISABLED and does not touch the toggle of known ones", async () => {
    fx.divisions = [
      { code: div.exactDivision, description: "BV", currency: "EUR" },
      { code: div.exactDivision + 1, description: "Second BV", currency: "GBP" },
    ];
    await run("incremental");
    await db.prepare("UPDATE divisions SET sync_enabled = 0 WHERE id = ?1").bind(div.id).run();
    await run("incremental");
    const rows = await db
      .prepare(
        "SELECT exact_division, name, base_currency, sync_enabled FROM divisions WHERE connection_id = ?1 ORDER BY exact_division",
      )
      .bind(div.connectionId)
      .all();
    expect(rows.results).toEqual([
      { exact_division: div.exactDivision, name: "BV", base_currency: "EUR", sync_enabled: 0 },
      {
        exact_division: div.exactDivision + 1,
        name: "Second BV",
        base_currency: "GBP",
        sync_enabled: 0,
      },
    ]);
  });

  it("reads the division's own currency and uses it for division-currency amounts", async () => {
    fx.divisions = [{ code: div.exactDivision, description: "BV", currency: "JPY" }];
    fx.accounts = [{ n: 1, name: "Acme", ts: 10, customer: true }];
    fx.receivables = [
      {
        n: 101,
        account: 1,
        name: "Acme",
        amount: 1500,
        currency: "JPY",
        invoiceNumber: 1,
        ts: 100,
        amountDc: 1500,
      },
    ];
    // The stored currency is still the EUR default when this run starts.
    expect(div.currency ?? "EUR").toBe("EUR");
    await run("incremental");
    const d = await db
      .prepare("SELECT base_currency, base_currency_read_at FROM divisions WHERE id = ?1")
      .bind(div.id)
      .first<{ base_currency: string; base_currency_read_at: string | null }>();
    expect(d?.base_currency).toBe("JPY");
    expect(d?.base_currency_read_at).not.toBeNull();
    const item = await db
      .prepare("SELECT open_dc_minor, dc_currency FROM open_items WHERE division_id = ?1")
      .bind(div.id)
      .first();
    // JPY has no minor unit: 1500 yen is 1500, not 150000.
    expect(item).toEqual({ open_dc_minor: 1500, dc_currency: "JPY" });
  });

  it("keeps the stored currency when Exact sends none", async () => {
    await db.prepare("UPDATE divisions SET base_currency = 'GBP' WHERE id = ?1").bind(div.id).run();
    fx.divisions = [{ code: div.exactDivision, description: "BV" }]; // no Currency field
    await run("incremental");
    const d = await db
      .prepare("SELECT base_currency, base_currency_read_at FROM divisions WHERE id = ?1")
      .bind(div.id)
      .first();
    expect(d).toEqual({ base_currency: "GBP", base_currency_read_at: null });
  });
});
