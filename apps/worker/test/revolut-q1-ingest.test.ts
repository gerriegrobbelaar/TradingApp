/**
 * Phase 5 review Q1, ingest: S6 (data matching and booking will need), S9 (a matched final row is
 * frozen; different data only flags it), S7 (state conflicts flag the row).
 */
import { mapTransaction, parseJsonRawNumbers } from "@camelthorn/revolut";
import { beforeEach, describe, expect, it } from "vitest";
import { isFrozen, upsertTransaction, type IngestSource } from "../src/revolut/ingest";
import { db } from "./helpers";
import { insertLiveMatch } from "./matching-helpers";
import { resetRevolut, seedRevolut } from "./revolut-helpers";
import { rawLeg, rawTx, type RawRow } from "./revolut-q1-helpers";
import { rowsOf } from "./revolut-r3-helpers";

let connId: number;

beforeEach(async () => {
  await resetRevolut();
  connId = await seedRevolut({ status: "active" });
});

const T0 = "2026-07-10T08:00:00.000Z";
const at = (sec: number): string => new Date(Date.parse(T0) + sec * 1000).toISOString();

const parse = (raw: RawRow) => mapTransaction(parseJsonRawNumbers(JSON.stringify(raw)));
const ingest = (raw: RawRow, source: IngestSource = "poll") =>
  upsertTransaction({ DB: db }, connId, parse(raw), source, Date.parse(T0) + 3_600_000);
const row = async (): Promise<Record<string, unknown>> =>
  (await rowsOf("bank_transactions"))[0] as Record<string, unknown>;

const rich = (over: RawRow = {}): RawRow =>
  rawTx(
    "tx-rich",
    T0,
    [
      rawLeg("l1", {
        amount: -100.5,
        fee: -0.25,
        balance: 900.25,
        bill_amount: -110,
        bill_currency: "USD",
        card: { card_number: "123456******7890" },
        counterparty: {
          id: "cp-9",
          account_id: "cpa-9",
          account_type: "external",
          name: "Acme B.V.",
          iban: "nl91 abna 0417 1643 00",
        },
      }),
    ],
    {
      reason_code: "none",
      merchant: { name: "Shop Amsterdam", city: "Amsterdam" },
      ...over,
    },
  );

async function markMatched(opts: { liveMatch?: boolean; status?: string } = {}): Promise<number> {
  const id = (await row())["id"] as number;
  if (opts.liveMatch !== false) await insertLiveMatch(id);
  if (opts.status !== undefined) {
    await db
      .prepare("UPDATE bank_transactions SET match_status = ?2 WHERE id = ?1")
      .bind(id, opts.status)
      .run();
  }
  return id;
}

describe("S6: what matching and booking will need", () => {
  it("stores fee, balance, counterparty ids, reason, bill amount, merchant and the card's last four", async () => {
    await ingest(rich());
    expect(await row()).toMatchObject({
      amount_minor: -10050,
      fee_minor: -25,
      fee_currency: "EUR",
      balance_minor: 90025,
      counterparty_ref: "cp-9",
      counterparty_account_ref: "cpa-9",
      counterparty_account_type: "external",
      counterparty_name: "Acme B.V.",
      counterparty_iban: "NL91ABNA0417164300",
      reason_code: "none",
      bill_amount_minor: -11000,
      bill_currency: "USD",
      card_last4: "7890",
      merchant_name: "Shop Amsterdam",
      skipped_legs: 0,
      state_conflict: 0,
    });
  });

  it("the card number never reaches storage, only its last four digits", async () => {
    await ingest(rich({ card: { card_number: "4111111111111111" } }));
    const r = await row();
    expect(JSON.stringify(r)).not.toMatch(/123456|411111|\*{4}/);
    expect(r["card_last4"]).toBe("7890");
  });

  it("a leg without the extras leaves the columns empty", async () => {
    await ingest(rawTx("plain", T0));
    expect(await row()).toMatchObject({
      fee_minor: null,
      fee_currency: null,
      balance_minor: null,
      bill_amount_minor: null,
      bill_currency: null,
      card_last4: null,
      merchant_name: null,
      reason_code: null,
    });
  });

  it("a same-state refresh fills the new columns of an existing UNMATCHED row", async () => {
    await ingest(rich());
    await db
      .prepare(
        `UPDATE bank_transactions SET fee_minor = NULL, fee_currency = NULL, balance_minor = NULL,
           counterparty_ref = NULL, reason_code = NULL, card_last4 = NULL, merchant_name = NULL`,
      )
      .run();
    const r = await ingest(rich(), "backfill");
    expect(r.updated).toBe(1);
    expect(await row()).toMatchObject({
      fee_minor: -25,
      balance_minor: 90025,
      counterparty_ref: "cp-9",
      reason_code: "none",
      card_last4: "7890",
      merchant_name: "Shop Amsterdam",
    });
  });

  it("a matched row is not filled by a refresh (S9)", async () => {
    await ingest(rich());
    await db
      .prepare("UPDATE bank_transactions SET fee_minor = NULL, counterparty_ref = NULL")
      .run();
    await markMatched({ status: "matched" });
    const r = await ingest(rich(), "backfill");
    expect(r.frozenConflicts).toBe(0);
    expect(await row()).toMatchObject({
      fee_minor: null,
      counterparty_ref: null,
      state_conflict: 0,
    });
  });

  it("an unsafe counterparty id is dropped, not stored", async () => {
    await ingest(rawTx("odd", T0, [rawLeg("l", { counterparty: { id: "a b;drop", name: "X" } })]));
    expect((await row())["counterparty_ref"]).toBeNull();
  });
});

describe("S9: freezing a matched final row", () => {
  const completed = (over: RawRow = {}, legOver: RawRow = {}, updated = 5): RawRow =>
    rawTx("tx-f", T0, [rawLeg("l1", legOver)], { updated_at: at(updated), ...over });

  it("isFrozen: final and (live match or match_status matched/ignored)", () => {
    const base = { match_status: "unmatched", live_matches: 0, is_final: 1 };
    expect(isFrozen(base)).toBe(false);
    expect(isFrozen({ ...base, live_matches: 1 })).toBe(true);
    expect(isFrozen({ ...base, match_status: "matched" })).toBe(true);
    // Phase 7: a suggestion is advice, not a decision.
    expect(isFrozen({ ...base, match_status: "suggested" })).toBe(false);
    expect(isFrozen({ ...base, match_status: "ignored" })).toBe(true);
    expect(isFrozen({ ...base, is_final: 0, live_matches: 1 })).toBe(false);
  });

  it("different money data on a row with a live match is ignored and flags the row", async () => {
    await ingest(completed({}, { amount: -10, counterparty: { id: "cp-1", name: "Acme" } }, 0));
    await markMatched();
    const r = await ingest(
      completed(
        { reference: "changed" },
        {
          amount: -99,
          counterparty: { id: "cp-1", name: "Other Name", iban: "DE89370400440532013000" },
        },
      ),
    );
    expect(r.frozenConflicts).toBe(1);
    expect(r.updated).toBe(1); // the flag
    expect(await row()).toMatchObject({
      amount_minor: -1000,
      counterparty_name: "Acme",
      reference: "Invoice 2026001",
      state_conflict: 1,
      updated_at: at(5),
    });
    expect((await row())["counterparty_iban"]).toBeNull();
  });

  it("the same data again does not flag, and changes nothing", async () => {
    await ingest(completed({}, {}, 0));
    await markMatched();
    const r = await ingest(completed({}, {}, 5));
    expect(r.frozenConflicts).toBe(0);
    expect(r.unchanged + r.updated).toBe(1);
    expect(await row()).toMatchObject({ state_conflict: 0, amount_minor: -2550 });
  });

  it("match_status 'matched' alone (no matches row) freezes too", async () => {
    await ingest(completed({}, { amount: -10 }, 0));
    await markMatched({ liveMatch: false, status: "matched" });
    const r = await ingest(completed({}, { amount: -99 }));
    expect(r.frozenConflicts).toBe(1);
    expect((await row())["amount_minor"]).toBe(-1000);
  });

  it("an undone match on an unmatched row does not freeze it", async () => {
    await ingest(completed({}, { amount: -10 }, 0));
    const id = await markMatched();
    await db
      .prepare("UPDATE matches SET undone_at = ?2, undone_by = 'x' WHERE bank_transaction_id = ?1")
      .bind(id, T0)
      .run();
    const r = await ingest(completed({}, { amount: -99 }));
    expect(r.frozenConflicts).toBe(0);
    expect(await row()).toMatchObject({ amount_minor: -9900, state_conflict: 0 });
  });

  it("a pending row is never frozen (only final rows are booked)", async () => {
    await ingest(completed({ state: "pending" }, { amount: -10 }, 0));
    // The matching guards (migration 0022) refuse a match on a pending line, so only the status is set.
    await markMatched({ liveMatch: false, status: "matched" });
    const r = await ingest(completed({ state: "pending" }, { amount: -99 }));
    expect(r.frozenConflicts).toBe(0);
    expect((await row())["amount_minor"]).toBe(-9900);
  });

  it("completed -> reverted on a matched row moves the state and flags it for the alert", async () => {
    await ingest(completed({}, { amount: -10 }, 0));
    await markMatched();
    const r = await ingest(completed({ state: "reverted" }, { amount: -10 }, 9));
    expect(r.frozenConflicts).toBe(1);
    expect(await row()).toMatchObject({
      state: "reverted",
      state_conflict: 1,
      amount_minor: -1000,
    });
  });

  it("a refused state change flags any row, matched or not (S7)", async () => {
    await ingest(completed({}, {}, 0));
    const r = await ingest(completed({ state: "failed" }, {}, 9));
    expect(r.blocked.conflict).toBe(1);
    expect(r.updated).toBe(1);
    expect(await row()).toMatchObject({ state: "completed", state_conflict: 1 });
    // Sticky: a later, ordinary refresh does not clear it.
    await ingest(completed({}, {}, 20));
    expect((await row())["state_conflict"]).toBe(1);
  });

  it("the booking date and the final state stay on a frozen row", async () => {
    await ingest(completed({ completed_at: at(0) }, {}, 0));
    await markMatched();
    await ingest(completed({ completed_at: at(3600) }, {}, 7));
    expect(await row()).toMatchObject({ booked_at: at(0), state_conflict: 0 });
  });

  describe("a match that lands between the read and the write", () => {
    /** A D1 handle whose FIRST batch waits for `between`: a writer that read, then stalls. */
    const stallingDb = (between: () => Promise<unknown>): D1Database => {
      let stalled = false;
      return new Proxy(db, {
        get(target, prop) {
          if (prop === "batch") {
            return async (stmts: D1PreparedStatement[]) => {
              if (!stalled) {
                stalled = true;
                await between();
              }
              return target.batch(stmts);
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    };

    for (const variant of ["match_status set", "a live matches row only"] as const) {
      it(`${variant}: the stale write loses and the next pass sees the row frozen`, async () => {
        await ingest(completed({}, { amount: -10 }, 0));
        const r = await upsertTransaction(
          {
            DB: stallingDb(() =>
              markMatched(
                variant === "match_status set"
                  ? { liveMatch: false, status: "matched" }
                  : { liveMatch: true },
              ),
            ),
          },
          connId,
          parse(completed({}, { amount: -99 })),
          "poll",
          Date.parse(T0),
        );
        expect(r.frozenConflicts).toBe(1);
        expect(await row()).toMatchObject({ amount_minor: -1000, state_conflict: 1 });
      });
    }
  });
});
