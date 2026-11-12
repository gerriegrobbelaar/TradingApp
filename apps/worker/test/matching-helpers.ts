import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import type { JobContext } from "../src/jobs/types";
import { SETTING_AUTO, SETTING_CONFIG, SETTING_ENABLED } from "../src/matching/config";
import { resetRevolut, seedRevolut } from "./revolut-helpers";
import { addDivision, resetSync } from "./sync-helpers";

export const db = env.DB;
export const NOW = Date.parse("2026-07-15T10:00:00Z");
export const OUR_IBAN = "NL02ABNA0123456789";
export const CUSTOMER_IBAN = "NL91ABNA0417164300";
export const SUPPLIER_IBAN = "DE89370400440532013000";

export interface World {
  divisionId: number;
  exactConnectionId: number;
  revolutConnectionId: number;
  accountId: number;
}

/** Wipes everything the matching tests touch and builds one Exact division + one mapped Revolut account. */
export async function resetWorld(opts: { mapped?: boolean } = {}): Promise<World> {
  await resetRevolut();
  await resetSync();
  await db.batch([
    db.prepare("DELETE FROM ledger_patterns"),
    db.prepare("DELETE FROM settings WHERE key LIKE 'matching.%'"),
  ]);
  const div = await addDivision();
  const revolutConnectionId = await seedRevolut({ status: "active" });
  const acc = await db
    .prepare(
      `INSERT INTO bank_accounts (connection_id, external_id, name, iban, currency, is_active)
       VALUES (?1, 'acc-1', 'Main EUR', ?2, 'EUR', 1)`,
    )
    .bind(revolutConnectionId, OUR_IBAN)
    .run();
  const accountId = acc.meta.last_row_id;
  if (opts.mapped !== false) await mapAccount(accountId, div.id);
  // Fresh open items by default (S4); tests of staleness overwrite this.
  await markOpenItemsSynced(div.id, new Date(NOW - 3_600_000).toISOString());
  // The data quality rules want every source freshly synchronised too (review V1 S5).
  await markSourcesSynced(div.id, revolutConnectionId, new Date(NOW - 3_600_000).toISOString());
  return {
    divisionId: div.id,
    exactConnectionId: div.connectionId,
    revolutConnectionId,
    accountId,
  };
}

/** Stamps the other Exact entities and the Revolut reads as completed at `at` (null = never). */
export async function markSourcesSynced(
  divisionId: number,
  revolutConnectionId: number,
  at: string | null,
): Promise<void> {
  const exact = ["relations", "relation_ibans", "purchase_entries", "gl_balances"];
  await db.batch([
    ...exact.map((e) =>
      db
        .prepare("DELETE FROM sync_state WHERE division_id = ?1 AND entity = ?2")
        .bind(divisionId, e),
    ),
    db.prepare("DELETE FROM revolut_sync_state WHERE connection_id = ?1").bind(revolutConnectionId),
  ]);
  if (at === null) return;
  await db.batch([
    ...exact.map((e) =>
      db
        .prepare(
          `INSERT INTO sync_state (division_id, entity, last_completed_at, last_finished_at, last_status)
           VALUES (?1, ?2, ?3, ?3, 'ok')`,
        )
        .bind(divisionId, e, at),
    ),
    ...["accounts", "transactions"].map((e) =>
      db
        .prepare(
          `INSERT INTO revolut_sync_state (connection_id, entity, last_completed_at, last_finished_at, last_status)
           VALUES (?1, ?2, ?3, ?3, 'ok')`,
        )
        .bind(revolutConnectionId, e, at),
    ),
  ]);
}

/** Stamps the last complete open-items pass of a division (null = never completed). */
export async function markOpenItemsSynced(
  divisionId: number,
  receivablesAt: string | null,
  payablesAt: string | null = receivablesAt,
): Promise<void> {
  for (const [entity, at] of [
    ["receivables", receivablesAt],
    ["payables", payablesAt],
  ] as const) {
    await db
      .prepare("DELETE FROM sync_state WHERE division_id = ?1 AND entity = ?2")
      .bind(divisionId, entity)
      .run();
    if (at === null) continue;
    await db
      .prepare(
        `INSERT INTO sync_state (division_id, entity, last_completed_at, last_finished_at, last_status)
         VALUES (?1, ?2, ?3, ?3, 'ok')`,
      )
      .bind(divisionId, entity, at)
      .run();
  }
}

export async function mapAccount(accountId: number, divisionId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bank_account_exact_map (bank_account_id, division_id, journal_code, bank_gl_account_code,
                                            created_by, updated_by)
       VALUES (?1, ?2, '90', '1210', 'test', 'test')
       ON CONFLICT (bank_account_id) DO UPDATE SET division_id = excluded.division_id`,
    )
    .bind(accountId, divisionId)
    .run();
}

let seq = 0;

export interface RelationOpts {
  divisionId: number;
  exactId?: string;
  name?: string;
  ibans?: string[];
  ibanAddedAt?: string | null;
  ibanChangedAt?: string | null;
}

export async function addRelation(o: RelationOpts): Promise<{ id: number; exactId: string }> {
  const exactId = o.exactId ?? `rel-${++seq}`;
  const r = await db
    .prepare(
      `INSERT INTO relations (division_id, exact_id, name, is_supplier, is_customer, iban, iban_added_at,
                              iban_changed_at, updated_at)
       VALUES (?1, ?2, ?3, 1, 1, ?4, ?5, ?6, '2026-07-01T00:00:00.000Z')`,
    )
    .bind(
      o.divisionId,
      exactId,
      o.name ?? "Acme B.V.",
      o.ibans?.[0] ?? null,
      o.ibanAddedAt ?? null,
      o.ibanChangedAt ?? null,
    )
    .run();
  const id = r.meta.last_row_id;
  for (const iban of o.ibans ?? []) {
    await db
      .prepare(
        `INSERT INTO relation_bank_accounts (division_id, relation_id, iban, first_seen_at, last_seen_at)
         VALUES (?1, ?2, ?3, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
      )
      .bind(o.divisionId, id, iban)
      .run();
  }
  return { id, exactId };
}

export interface ItemOpts {
  divisionId: number;
  kind?: "invoice" | "bill";
  invoiceNumber?: string | null;
  openMinor: number;
  currency?: string;
  relationExactId?: string | null;
  relationName?: string | null;
  dueDate?: string | null;
  status?: "open" | "closed";
  reference?: string | null;
}

export async function addItem(o: ItemOpts): Promise<number> {
  const n = ++seq;
  const r = await db
    .prepare(
      `INSERT INTO open_items (division_id, exact_id, kind, relation_id, relation_name, invoice_number,
                               reference, currency, stored_minor, open_minor, due_date, status, synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, '2026-07-14T00:00:00.000Z')`,
    )
    .bind(
      o.divisionId,
      `item-${n}`,
      o.kind ?? "invoice",
      o.relationExactId ?? null,
      o.relationName ?? null,
      o.invoiceNumber === undefined ? `2026${String(n).padStart(4, "0")}` : o.invoiceNumber,
      o.reference ?? null,
      o.currency ?? "EUR",
      o.openMinor,
      o.dueDate ?? "2026-07-20",
      o.status ?? "open",
    )
    .run();
  return r.meta.last_row_id;
}

export interface TxOpts {
  accountId: number;
  connectionId: number;
  amountMinor: number;
  currency?: string;
  reference?: string | null;
  counterpartyName?: string | null;
  counterpartyIban?: string | null;
  type?: string | null;
  state?: string;
  matchStatus?: string;
  stateConflict?: boolean;
  createdAt?: string;
  accountType?: string | null;
}

export async function addTx(o: TxOpts): Promise<number> {
  const n = ++seq;
  const created = o.createdAt ?? "2026-07-14T08:00:00.000Z";
  const r = await db
    .prepare(
      `INSERT INTO bank_transactions (connection_id, bank_account_id, external_id, leg_id, type, state,
         amount_minor, currency, counterparty_name, counterparty_iban, reference, booked_at, created_at,
         completed_at, match_status, state_conflict, counterparty_account_type, first_seen_at)
       VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11, ?12, ?13, ?14, ?11)`,
    )
    .bind(
      o.connectionId,
      o.accountId,
      `tx-${n}`,
      o.type === undefined ? "transfer" : o.type,
      o.state ?? "completed",
      o.amountMinor,
      o.currency ?? "EUR",
      o.counterpartyName ?? null,
      o.counterpartyIban ?? null,
      o.reference ?? null,
      created,
      o.matchStatus ?? "unmatched",
      o.stateConflict ? 1 : 0,
      o.accountType === undefined ? "external" : o.accountType,
    )
    .run();
  return r.meta.last_row_id;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_by) VALUES (?1, ?2, 'test')
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .bind(key, JSON.stringify(value))
    .run();
}

export const enableAuto = (): Promise<void> => setSetting(SETTING_AUTO, true);
export { SETTING_AUTO, SETTING_CONFIG, SETTING_ENABLED };

export function jobContext(over: Partial<JobContext> = {}, e: Env = env): JobContext {
  return {
    env: e,
    job: { id: 1, name: "bank.match", handler: "bank.match", exactBudget: 0 },
    run: { id: 1, attempt: 1, scheduledFor: new Date(NOW).toISOString(), requestedBy: "system" },
    trigger: "schedule",
    budget: 0,
    deadlineMs: NOW + 60 * 60_000,
    signal: new AbortController().signal,
    log: () => undefined,
    now: () => NOW,
    ...over,
  };
}

export async function liveMatches(): Promise<number> {
  return (
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM matches WHERE undone_at IS NULL")
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

export async function txStatus(id: number): Promise<string> {
  return (
    (await db
      .prepare("SELECT match_status FROM bank_transactions WHERE id = ?1")
      .bind(id)
      .first<{ match_status: string }>()) as { match_status: string }
  ).match_status;
}

/** A live ledger match inserted straight into the table (tests of other features). Needs a mapped account. */
export async function insertLiveMatch(txId: number): Promise<number> {
  const t = await db
    .prepare("SELECT bank_account_id, amount_minor, currency FROM bank_transactions WHERE id = ?1")
    .bind(txId)
    .first<{ bank_account_id: number; amount_minor: number; currency: string }>();
  if (!t) throw new Error("no such transaction");
  const map = await db
    .prepare("SELECT division_id FROM bank_account_exact_map WHERE bank_account_id = ?1")
    .bind(t.bank_account_id)
    .first<{ division_id: number }>();
  let divisionId = map?.division_id;
  if (divisionId === undefined) {
    const div = await addDivision();
    divisionId = div.id;
    await mapAccount(t.bank_account_id, divisionId);
  }
  const r = await db
    .prepare(
      `INSERT INTO matches (bank_transaction_id, division_id, source, ledger_account_code, amount_minor,
                            currency, created_by)
       VALUES (?1, ?2, 'ledger', '1300', ?3, ?4, 'test@example.com')`,
    )
    .bind(txId, divisionId, Math.abs(t.amount_minor), t.currency)
    .run();
  return r.meta.last_row_id;
}
