import { env } from "cloudflare:test";
import { BOOKING_PROTOCOL_VERSION } from "../src/booking/protocol";
import { runBookMatches } from "../src/booking/executor";
import { SETTING_ENABLED, SETTING_VERIFIED } from "../src/booking/settings";
import { applyMatch } from "../src/matching/store";
import type { HandlerResult } from "../src/jobs/types";
import type { FakeExact } from "./booking-fake-exact";
import {
  addItem,
  addRelation,
  addTx,
  jobContext,
  NOW,
  resetWorld,
  setSetting,
  type World,
} from "./matching-helpers";
import { fakeGate } from "./sync-helpers";

export const db = env.DB;
export { NOW };

let seq = 0;
export const guid = (n: number): string => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface BookingWorld extends World {
  creates: boolean;
}

export const VERIFIED_AT = "2026-07-01T00:00:00.000Z";

/** Marks the write path verified at the CURRENT protocol version and switches booking on/off. */
export async function setBooking(
  enabled: boolean,
  verified: boolean | string = true,
): Promise<void> {
  await setSetting(SETTING_ENABLED, enabled);
  await db.prepare("DELETE FROM settings WHERE key = ?1").bind(SETTING_VERIFIED).run();
  if (verified !== false) {
    await setSetting(SETTING_VERIFIED, {
      at: VERIFIED_AT,
      by: "gerrie.grobbelaar@camelthorncapital.com",
      note: "Test division verified in the test",
      protocolVersion: verified === true ? BOOKING_PROTOCOL_VERSION : verified,
    });
  }
}

/** One Exact division, one mapped Revolut account (journal 90), control accounts, booking ON. */
export async function bookingWorld(
  o: { creates?: boolean; enabled?: boolean; verified?: boolean } = {},
): Promise<BookingWorld> {
  const w = await resetWorld();
  const creates = o.creates ?? true;
  await db.batch([
    db.prepare("DELETE FROM exact_write_outbox"),
    db.prepare("DELETE FROM booking_call_ledger"),
    db.prepare("DELETE FROM gl_accounts"),
    db.prepare("DELETE FROM settings WHERE key LIKE 'exact.booking_%'"),
    db
      .prepare("UPDATE connections SET creates_bank_entries = ?2 WHERE id = ?1")
      .bind(w.revolutConnectionId, creates ? 1 : 0),
    db.prepare(
      `UPDATE bank_account_exact_map SET receivable_gl_account_code = '1300', payable_gl_account_code = '1600'`,
    ),
  ]);
  await setBooking(o.enabled ?? true, o.verified ?? true);
  return { ...w, creates };
}

export interface Seeded {
  matchId: number;
  txId: number;
  itemId: number;
  relationGuid: string;
  entryNumber: number;
  txExternalId: string;
}

/**
 * A live manual match of one bank line to one open item (default: an invoice paid in full), old
 * enough to be booked, with the item mirrored in the fake Exact. `kind: 'bill'` is a bill paid out.
 */
export async function seedBookable(
  w: BookingWorld,
  fake: FakeExact | null,
  o: {
    kind?: "invoice" | "bill";
    amountMinor?: number;
    openMinor?: number;
    allocMinor?: number;
    invoiceNumber?: string;
    relation?: { guid: string; code: string | null };
    entryNumber?: number | null;
    currency?: string;
    createdAt?: string;
  } = {},
): Promise<Seeded> {
  const n = ++seq;
  const kind = o.kind ?? "invoice";
  const amount = o.amountMinor ?? 12_345;
  const openAbs = o.openMinor ?? amount;
  const alloc = o.allocMinor ?? Math.min(amount, openAbs);
  const currency = o.currency ?? "EUR";
  const relGuid = o.relation?.guid ?? guid(n);
  const known = await db
    .prepare("SELECT id FROM relations WHERE division_id = ?1 AND exact_id = ?2")
    .bind(w.divisionId, relGuid)
    .first();
  if (known === null) {
    await addRelation({ divisionId: w.divisionId, exactId: relGuid, name: `Acme ${n} B.V.` });
    await db
      .prepare("UPDATE relations SET code = ?3 WHERE division_id = ?1 AND exact_id = ?2")
      .bind(w.divisionId, relGuid, o.relation === undefined ? `R${100 + n}` : o.relation.code)
      .run();
  }
  const entryNumber = o.entryNumber === undefined ? 20 + n : o.entryNumber;
  const itemId = await addItem({
    divisionId: w.divisionId,
    kind,
    openMinor: openAbs,
    currency,
    relationExactId: relGuid,
    invoiceNumber: o.invoiceNumber ?? String(2026000 + n),
  });
  await db
    .prepare("UPDATE open_items SET entry_number = ?2 WHERE id = ?1")
    .bind(itemId, entryNumber)
    .run();
  const signed = kind === "invoice" ? amount : -amount;
  const txId = await addTx({
    accountId: w.accountId,
    connectionId: w.revolutConnectionId,
    amountMinor: signed,
    currency,
    counterpartyName: `Acme ${n} B.V.`,
    reference: `Payment ${2026000 + n}`,
  });
  const m = await applyMatch(db, {
    txId,
    divisionId: w.divisionId,
    txAmountMinor: amount,
    currency,
    source: "manual",
    ledgerAccountCode: null,
    score: null,
    rule: null,
    note: null,
    actor: "fin@camelthorncapital.com",
    allocations: [{ openItemId: itemId, allocatedMinor: alloc, remainingAfter: openAbs - alloc }],
    nowIso: "2026-07-15T07:59:00.000Z",
  });
  if (!m.ok) throw new Error(`seed match failed: ${m.code}`);
  await db
    .prepare("UPDATE matches SET created_at = ?2 WHERE id = ?1")
    .bind(m.matchId, o.createdAt ?? "2026-07-15T08:00:00.000Z")
    .run();
  const tx = await db
    .prepare("SELECT external_id FROM bank_transactions WHERE id = ?1")
    .bind(txId)
    .first<{ external_id: string }>();
  if (fake !== null && entryNumber !== null) {
    fake.addItem({
      entryNumber,
      account: relGuid,
      kind: kind === "invoice" ? "receivable" : "payable",
      openMinor: openAbs,
      currency,
    });
  }
  return {
    matchId: m.matchId,
    txId,
    itemId,
    relationGuid: relGuid,
    entryNumber: entryNumber ?? 0,
    txExternalId: (tx as { external_id: string }).external_id,
  };
}

/** A live ledger match (fees and the like) with its GL account known to the sync. */
export async function seedLedger(
  w: BookingWorld,
  o: { amountMinor?: number; code?: string; withGl?: boolean } = {},
): Promise<Seeded> {
  const n = ++seq;
  const amount = o.amountMinor ?? -250;
  const code = o.code ?? "4500";
  if (o.withGl !== false) {
    await db
      .prepare(
        `INSERT INTO gl_accounts (division_id, exact_id, code, name, updated_at)
         VALUES (?1, ?2, ?3, 'Bank costs', '2026-07-01T00:00:00.000Z')`,
      )
      .bind(w.divisionId, guid(900 + n), code)
      .run();
  }
  const txId = await addTx({
    accountId: w.accountId,
    connectionId: w.revolutConnectionId,
    amountMinor: amount,
    counterpartyName: "Revolut",
    reference: "Monthly fee",
  });
  const m = await applyMatch(db, {
    txId,
    divisionId: w.divisionId,
    txAmountMinor: Math.abs(amount),
    currency: "EUR",
    source: "ledger",
    ledgerAccountCode: code,
    score: null,
    rule: null,
    note: null,
    actor: "fin@camelthorncapital.com",
    allocations: [],
    nowIso: "2026-07-15T07:59:00.000Z",
  });
  if (!m.ok) throw new Error(`seed ledger match failed: ${m.code}`);
  await db
    .prepare("UPDATE matches SET created_at = '2026-07-15T08:00:00.000Z' WHERE id = ?1")
    .bind(m.matchId)
    .run();
  return {
    matchId: m.matchId,
    txId,
    itemId: 0,
    relationGuid: "",
    entryNumber: 0,
    txExternalId: "",
  };
}

/** A D1 handle that counts every executed statement (reads, writes) and batch as one operation. */
export function countingDb(): { db: D1Database; ops: () => number } {
  let ops = 0;
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop) {
        const v = Reflect.get(target, prop) as unknown;
        if (prop === "bind") {
          return (...a: unknown[]) =>
            wrap((target.bind as (...x: unknown[]) => D1PreparedStatement)(...a));
        }
        if (prop === "all" || prop === "first" || prop === "run" || prop === "raw") {
          return (...a: unknown[]) => {
            ops++;
            return (v as (...x: unknown[]) => unknown).apply(target, a);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          ops++;
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: proxy, ops: () => ops };
}

export async function runBooking(
  fake: FakeExact,
  o: {
    now?: number;
    budget?: number;
    signal?: AbortSignal;
    trigger?: "schedule" | "manual";
    db?: D1Database;
  } = {},
): Promise<HandlerResult> {
  const now = o.now ?? NOW;
  return runBookMatches(
    jobContext(
      {
        job: { id: 1, name: "exact.book_matches", handler: "exact.book_matches", exactBudget: 30 },
        budget: o.budget ?? 30,
        now: () => now,
        deadlineMs: now + 60 * 60_000,
        trigger: o.trigger ?? "schedule",
        ...(o.signal ? { signal: o.signal } : {}),
        syncDeps: { transport: fake.transport, gate: fakeGate(), now: () => now },
      },
      o.db === undefined ? env : { ...env, DB: o.db },
    ),
  );
}

export interface OutboxSnap {
  id: number;
  kind: string;
  status: string;
  attempts: number;
  last_error_code: string | null;
  exact_ref: string | null;
  needs_probe: number;
  match_id: number;
}

export async function outbox(matchId?: number): Promise<OutboxSnap[]> {
  return (
    await db
      .prepare(
        `SELECT id, kind, status, attempts, last_error_code, exact_ref, needs_probe, match_id
         FROM exact_write_outbox WHERE (?1 IS NULL OR match_id = ?1) ORDER BY id`,
      )
      .bind(matchId ?? null)
      .all<OutboxSnap>()
  ).results;
}

export async function matchRow(
  id: number,
): Promise<{ exact_state: string; exact_note: string | null; booked_at: string | null }> {
  return (await db
    .prepare("SELECT exact_state, exact_note, booked_at FROM matches WHERE id = ?1")
    .bind(id)
    .first()) as { exact_state: string; exact_note: string | null; booked_at: string | null };
}
