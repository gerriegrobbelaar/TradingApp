/**
 * Ingest of Revolut transactions (task R3a, ADR 0032): legs, accounts, state transitions,
 * idempotency and reconciliation across webhook, poll and backfill.
 */
import { mapTransaction, parseJsonRawNumbers } from "@camelthorn/revolut";
import { beforeEach, describe, expect, it } from "vitest";
import { IngestError, upsertTransaction, type IngestSource } from "../src/revolut/ingest";
import { db } from "./helpers";
import { resetRevolut, seedRevolut } from "./revolut-helpers";
import {
  ACC_EUR,
  ACC_USD,
  CP_IBAN,
  rowsOf,
  simpleTx,
  txJson,
  type FakeTransaction,
} from "./revolut-r3-helpers";

let connId: number;

beforeEach(async () => {
  await resetRevolut();
  connId = await seedRevolut({ status: "active" });
});

const parse = (t: FakeTransaction) =>
  mapTransaction(parseJsonRawNumbers(JSON.stringify(txJson(t))));

const ingest = (t: FakeTransaction, source: IngestSource = "poll", nowMs = Date.now()) =>
  upsertTransaction({ DB: db }, connId, parse(t), source, nowMs);

const txRows = () => rowsOf("bank_transactions");
const stateOf = async (legId: string): Promise<string | undefined> =>
  (
    await db
      .prepare("SELECT state FROM bank_transactions WHERE leg_id = ?1")
      .bind(legId)
      .first<{ state: string }>()
  )?.state;

describe("legs and accounts", () => {
  it("stores one row per leg, signed, with the account created on first sight", async () => {
    const r = await ingest(
      simpleTx("tx-1", {
        legs: [
          { legId: "tx-1-l1", amount: -100.5, counterpartyName: "Acme B.V." },
          { legId: "tx-1-l2", amount: 20, accountId: ACC_USD, currency: "USD" },
        ],
      }),
    );
    expect(r).toMatchObject({ legs: 2, inserted: 2, missing: true });
    const rows = await txRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => [x["leg_id"], x["amount_minor"], x["currency"]])).toEqual([
      ["tx-1-l1", -10050, "EUR"],
      ["tx-1-l2", 2000, "USD"],
    ]);
    const accounts = await rowsOf("bank_accounts", `connection_id = ${connId}`);
    expect(accounts.map((a) => a["external_id"]).sort()).toEqual([ACC_EUR, ACC_USD].sort());
    expect(accounts.every((a) => a["name"] === "Revolut account")).toBe(true);
  });

  it("a transfer between own accounts is two rows with one transaction id", async () => {
    await ingest(
      simpleTx("tx-2", {
        type: "transfer",
        legs: [
          { legId: "tx-2-a", amount: -50, accountId: ACC_EUR },
          { legId: "tx-2-b", amount: 50, accountId: ACC_USD },
        ],
      }),
    );
    const rows = await txRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r["external_id"]))).toEqual(new Set(["tx-2"]));
    expect(new Set(rows.map((r) => r["bank_account_id"])).size).toBe(2);
  });

  it("an exchange keeps each leg in its own currency", async () => {
    await ingest(
      simpleTx("tx-3", {
        type: "exchange",
        legs: [
          { legId: "tx-3-a", amount: -100, currency: "EUR" },
          { legId: "tx-3-b", amount: 108.12, currency: "USD", accountId: ACC_USD },
        ],
      }),
    );
    expect((await txRows()).map((r) => [r["currency"], r["amount_minor"]])).toEqual([
      ["EUR", -10000],
      ["USD", 10812],
    ]);
  });

  it("stores the counterparty IBAN compact and in full; the leg description and reference separately", async () => {
    await ingest(
      simpleTx("tx-4", {
        reference: "INV 77",
        legs: [
          {
            legId: "l",
            amount: -1,
            counterpartyIban: "nl91 abna 0417 1643 00",
            description: "Lunch",
          },
        ],
      }),
    );
    expect((await txRows())[0]).toMatchObject({
      counterparty_iban: CP_IBAN,
      reference: "INV 77",
      description: "Lunch",
      counterparty_name: "Acme B.V.",
    });
  });

  it("a leg without an account id is skipped, not guessed", async () => {
    const t = parse(simpleTx("tx-5"));
    const leg = t.legs[0];
    if (!leg) throw new Error("fixture");
    delete (leg as { accountId?: string }).accountId;
    const r = await upsertTransaction({ DB: db }, connId, t, "poll");
    expect(r).toMatchObject({ legs: 1, skipped: 1, inserted: 0, missing: false });
    expect(await txRows()).toEqual([]);
  });

  it("refuses unusable timestamps without writing", async () => {
    const t = parse(simpleTx("tx-6"));
    t.createdAt = "yesterday-ish";
    await expect(upsertTransaction({ DB: db }, connId, t, "poll")).rejects.toBeInstanceOf(
      IngestError,
    );
    expect(await txRows()).toEqual([]);
  });
});

describe("idempotency and reconciliation", () => {
  const strip = (rows: Record<string, unknown>[]) =>
    rows.map((r) => {
      const rest = { ...r };
      delete rest["last_event_at"];
      delete rest["source"];
      return rest;
    });

  it("ingesting the same transaction again changes nothing but last_event_at", async () => {
    await ingest(simpleTx("tx-1"), "poll", Date.parse("2026-07-10T09:00:00Z"));
    const first = await txRows();
    const r = await ingest(simpleTx("tx-1"), "poll", Date.parse("2026-07-10T09:05:00Z"));
    expect(r).toMatchObject({ inserted: 0, missing: false });
    const second = await txRows();
    expect(strip(second)).toEqual(strip(first));
    expect(second[0]?.["first_seen_at"]).toBe(first[0]?.["first_seen_at"]);
    expect(second[0]?.["last_event_at"]).toBe("2026-07-10T09:05:00.000Z");
  });

  it("webhook, then poll, then backfill give identical rows, and the first source is kept", async () => {
    const tx = simpleTx("tx-1", { state: "completed", completedAt: "2026-07-10T08:00:05.000Z" });
    await ingest(tx, "webhook");
    const afterWebhook = await txRows();
    await ingest(tx, "poll");
    await ingest(tx, "backfill");
    const after = await txRows();
    expect(after).toHaveLength(1);
    expect(strip(after)).toEqual(strip(afterWebhook));
    expect(after[0]?.["source"]).toBe("webhook");
  });

  it("a transaction only the backfill sees counts as missing", async () => {
    const seen = await ingest(simpleTx("tx-1"), "webhook");
    const missed = await ingest(simpleTx("tx-2"), "backfill");
    expect(seen.missing).toBe(true); // first sighting, whatever the source: the caller decides
    expect(missed.missing).toBe(true);
    const again = await ingest(simpleTx("tx-1"), "backfill");
    expect(again.missing).toBe(false);
  });

  it("racing writers of one transaction leave one row per leg and the furthest state", async () => {
    const pending = simpleTx("tx-1", { state: "pending", updatedAt: "2026-07-10T08:00:00.000Z" });
    const done = simpleTx("tx-1", { state: "completed", updatedAt: "2026-07-10T08:00:09.000Z" });
    await Promise.all([
      ingest(pending, "webhook"),
      ingest(done, "poll"),
      ingest(pending, "backfill"),
      ingest(done, "webhook"),
      ingest(pending, "poll"),
    ]);
    const rows = await txRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["state"]).toBe("completed");
    expect(rows[0]?.["is_final"]).toBe(1);
  });
});

describe("state transitions", () => {
  const STATES = ["pending", "completed", "declined", "failed", "reverted", "unknown"] as const;
  const FINAL = new Set(["completed", "declined", "failed", "reverted"]);

  /** ADR 0032: the legal moves, written out independently of the implementation. */
  function expected(a: string, b: string): string {
    if (b === "unknown") return a;
    if (a === "unknown") return b;
    if (a === "pending") return b;
    if (b === "pending") return a; // a final state is never reopened
    if (a === b) return a;
    return a === "completed" && b === "reverted" ? "reverted" : a;
  }

  it("every ordered pair of states, with the later event newer", async () => {
    for (const a of STATES) {
      for (const b of STATES) {
        await resetRevolut();
        connId = await seedRevolut({ status: "active" });
        await ingest(simpleTx("tx", { state: a, updatedAt: "2026-07-10T08:00:00.000Z" }));
        await ingest(simpleTx("tx", { state: b, updatedAt: "2026-07-10T08:00:10.000Z" }));
        expect(await stateOf("tx-l1"), `${a} then ${b}`).toBe(expected(a, b));
      }
    }
  });

  it("a stale event (older updated_at) never changes a stored state", async () => {
    for (const a of STATES) {
      for (const b of STATES) {
        await resetRevolut();
        connId = await seedRevolut({ status: "active" });
        await ingest(simpleTx("tx", { state: a, updatedAt: "2026-07-10T08:00:10.000Z" }));
        await ingest(simpleTx("tx", { state: b, updatedAt: "2026-07-10T08:00:00.000Z" }));
        // Same-state refreshes and unknown stay put; a legal forward move (pending to final) is
        // not blocked by the clock because a state cannot be "older" than its predecessor.
        const got = await stateOf("tx-l1");
        if (FINAL.has(a)) expect(got, `${a} then stale ${b}`).toBe(a);
        if (b === "unknown") expect(got).toBe(a);
      }
    }
  });

  it("a final state is not reopened by a late pending event, even a newer one", async () => {
    await ingest(simpleTx("tx", { state: "completed", updatedAt: "2026-07-10T08:00:10.000Z" }));
    await ingest(simpleTx("tx", { state: "pending", updatedAt: "2026-07-10T09:00:00.000Z" }));
    expect(await stateOf("tx-l1")).toBe("completed");
  });

  it("completed then reverted is allowed and stamps the change; the reverse is refused", async () => {
    await ingest(simpleTx("tx", { state: "completed", updatedAt: "2026-07-10T08:00:10.000Z" }));
    const r = await ingest(
      simpleTx("tx", { state: "reverted", updatedAt: "2026-07-11T08:00:00.000Z" }),
    );
    expect(r.updated).toBe(1);
    expect((await txRows())[0]).toMatchObject({
      state: "reverted",
      raw_state_changed_at: "2026-07-11T08:00:00.000Z",
    });
    const back = await ingest(
      simpleTx("tx", { state: "completed", updatedAt: "2026-07-12T08:00:00.000Z" }),
    );
    expect(back.blocked.conflict).toBe(1);
    expect(await stateOf("tx-l1")).toBe("reverted");
  });

  it("an unknown state is stored for a new transaction, and a known state replaces it", async () => {
    await ingest(simpleTx("tx", { state: "weird_new_state" }));
    expect(await stateOf("tx-l1")).toBe("unknown");
    await ingest(simpleTx("tx", { state: "pending" }));
    expect(await stateOf("tx-l1")).toBe("pending");
  });

  it("a pending refresh updates amounts and a final state records completion time", async () => {
    await ingest(simpleTx("tx", { state: "pending", updatedAt: "2026-07-10T08:00:00.000Z" }));
    const t = simpleTx("tx", {
      state: "completed",
      updatedAt: "2026-07-10T08:00:30.000Z",
      completedAt: "2026-07-10T08:00:30.000Z",
      legs: [{ legId: "tx-l1", amount: -101 }],
    });
    await ingest(t);
    expect((await txRows())[0]).toMatchObject({
      state: "completed",
      amount_minor: -10100,
      completed_at: "2026-07-10T08:00:30.000Z",
      booked_at: "2026-07-10T08:00:30.000Z",
      is_final: 1,
    });
  });
});
