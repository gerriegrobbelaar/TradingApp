import {
  approvalMappingHash,
  APPROVAL_MAPPING_VERIFIED_SETTING,
  ibanFingerprint,
  PAYMENTS_VERIFY_CHECKS,
  paymentsProtocolVersion,
  type PaymentSettings,
} from "@camelthorn/core";
import {
  PAYMENT_SETTINGS_KEY,
  PAYMENTS_ENABLED_KEY,
  PAYMENTS_VERIFIED_KEY,
} from "../src/payments/settings";
import { addSession, addUser } from "./helpers";
import { addItem, addRelation, db, resetWorld, setSetting, type World } from "./matching-helpers";

export { db };
export const SUPPLIER_IBAN = "NL91ABNA0417164300";
export const OTHER_IBAN = "DE89370400440532013000";

export interface PayWorld extends World {
  nowMs: number;
  relationRowId: number;
  relationExactId: string;
  itemId: number;
  entryNumber: number;
  /** email -> session token */
  tokens: Record<"finance" | "finance2" | "approver" | "approver2" | "admin" | "viewer", string>;
  emails: Record<"finance" | "finance2" | "approver" | "approver2" | "admin" | "viewer", string>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export async function putPaymentSettings(s: Partial<PaymentSettings>): Promise<void> {
  await setSetting(PAYMENT_SETTINGS_KEY, s);
}

export async function setVerified(
  on: boolean,
  protocolVersion = paymentsProtocolVersion(),
): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?1").bind(PAYMENTS_VERIFIED_KEY).run();
  if (!on) return;
  await setSetting(PAYMENTS_VERIFIED_KEY, {
    at: "2026-07-01T00:00:00.000Z",
    by: "gerrie.grobbelaar@camelthorncapital.com",
    note: "Sandbox checked in the test",
    protocolVersion,
    checks: [...PAYMENTS_VERIFY_CHECKS],
  });
}

export async function setSwitch(on: boolean): Promise<void> {
  await setSetting(PAYMENTS_ENABLED_KEY, on);
}

export async function setMappingVerified(on: boolean): Promise<void> {
  await db
    .prepare("DELETE FROM settings WHERE key = ?1")
    .bind(APPROVAL_MAPPING_VERIFIED_SETTING)
    .run();
  if (!on) return;
  await setSetting(APPROVAL_MAPPING_VERIFIED_SETTING, {
    verifiedAt: "2026-07-01T00:00:00.000Z",
    verifiedBy: "gerrie.grobbelaar@camelthorncapital.com",
    adrRef: "0025",
    mappingHash: approvalMappingHash(),
  });
}

/** Adds an approved purchase entry for the item's entry number (fresh read). */
export async function addEntry(
  divisionId: number,
  entryNumber: number,
  nowMs: number,
  o: { status?: string; statusCode?: number | null; syncedAt?: string; missed?: number } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO purchase_entries (division_id, exact_id, entry_number, currency, amount_minor, status,
                                     status_code, synced_at, missed_cycles)
       VALUES (?1, ?2, ?3, 'EUR', 100000, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      divisionId,
      `pe-${entryNumber}-${Math.random()}`,
      String(entryNumber),
      o.status ?? "approved",
      o.statusCode === undefined ? 50 : o.statusCode,
      o.syncedAt ?? iso(nowMs - 3600_000),
      o.missed ?? 0,
    )
    .run();
}

let entrySeq = 7000;

/** A fresh bill (open 1,000.00 EUR) of the world's supplier, with its approved Exact entry. */
export async function addBill(
  w: Pick<PayWorld, "divisionId" | "relationExactId" | "nowMs">,
  o: { openMinor?: number; currency?: string; number?: string | null; approved?: boolean } = {},
): Promise<{ itemId: number; entryNumber: number }> {
  const entryNumber = ++entrySeq;
  const itemId = await addItem({
    divisionId: w.divisionId,
    kind: "bill",
    openMinor: o.openMinor ?? 100_000,
    currency: o.currency ?? "EUR",
    relationExactId: w.relationExactId,
    invoiceNumber: o.number === undefined ? `INV-${entryNumber}` : o.number,
  });
  await db
    .prepare("UPDATE open_items SET entry_number = ?2, synced_at = ?3 WHERE id = ?1")
    .bind(itemId, entryNumber, iso(w.nowMs - 3600_000))
    .run();
  await addEntry(
    w.divisionId,
    entryNumber,
    w.nowMs,
    o.approved === false ? { status: "pending_approval", statusCode: 5 } : {},
  );
  return { itemId, entryNumber };
}

export async function verifyIbanRow(
  relationRowId: number,
  divisionId: number,
  iban: string,
  by: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO supplier_iban_verifications (division_id, relation_id, iban_fingerprint, kind, verified_by)
       VALUES (?1, ?2, ?3, 'verified', ?4)`,
    )
    .bind(divisionId, relationRowId, ibanFingerprint(iban), by)
    .run();
}

/**
 * Everything a payment needs, fresh relative to `nowMs` (default: the real clock, which the API routes
 * use): payments ON and verified, mapping verified, an active Revolut connection with an EUR account
 * holding 50,000.00, a supplier with a verified IBAN, one approved bill, users for every role.
 */
export async function payWorld(
  o: { nowMs?: number; verifyIban?: boolean; settings?: Partial<PaymentSettings> } = {},
): Promise<PayWorld> {
  const nowMs = o.nowMs ?? Date.now();
  const w = await resetWorld();
  await db.prepare("DELETE FROM settings WHERE key LIKE 'payments.%'").run();
  await db.batch([
    db.prepare("DELETE FROM sessions"),
    db.prepare("DELETE FROM user_roles"),
    db.prepare("DELETE FROM users"),
  ]);
  const emails = {
    finance: "finance@camelthorncapital.com",
    finance2: "finance2@camelthorncapital.com",
    approver: "approver@camelthorncapital.com",
    approver2: "approver2@camelthorncapital.com",
    admin: "admin@camelthorncapital.com",
    viewer: "viewer@camelthorncapital.com",
  } as const;
  const roles = {
    finance: ["finance"],
    finance2: ["finance"],
    approver: ["approver"],
    approver2: ["approver"],
    admin: ["admin"],
    viewer: ["viewer"],
  } as const;
  const tokens = {} as PayWorld["tokens"];
  for (const k of Object.keys(emails) as (keyof typeof emails)[]) {
    tokens[k] = await addSession(await addUser(emails[k], [...roles[k]]));
  }
  await setVerified(true);
  await setSwitch(true);
  await setMappingVerified(true);
  if (o.settings) await putPaymentSettings(o.settings);
  await db
    .prepare(
      "UPDATE bank_accounts SET balance_minor = 5000000, balance_at = ?2, state = 'active' WHERE id = ?1",
    )
    .bind(w.accountId, iso(nowMs - 60_000))
    .run();
  const rel = await addRelation({
    divisionId: w.divisionId,
    ibans: [SUPPLIER_IBAN],
    name: "Acme Supplies B.V.",
  });
  await db
    .prepare(
      "UPDATE relation_bank_accounts SET last_seen_at = ?2, first_seen_at = ?2 WHERE relation_id = ?1",
    )
    .bind(rel.id, iso(nowMs - 3600_000))
    .run();
  const base = { divisionId: w.divisionId, relationExactId: rel.exactId, nowMs };
  const bill = await addBill(base);
  if (o.verifyIban !== false) {
    await verifyIbanRow(rel.id, w.divisionId, SUPPLIER_IBAN, emails.approver);
  }
  return {
    ...w,
    nowMs,
    relationRowId: rel.id,
    relationExactId: rel.exactId,
    itemId: bill.itemId,
    entryNumber: bill.entryNumber,
    tokens,
    emails,
  };
}

/** Test setup: lifts the insert/status triggers, runs `fn`, puts them back (like withoutTriggers). */
export async function withoutPaymentTriggers<T>(names: string[], fn: () => Promise<T>): Promise<T> {
  const saved: string[] = [];
  for (const name of names) {
    const row = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1")
      .bind(name)
      .first<{ sql: string }>();
    if (row === null) throw new Error(`no trigger ${name}`);
    saved.push(row.sql);
    await db.prepare(`DROP TRIGGER ${name}`).run();
  }
  try {
    return await fn();
  } finally {
    for (const sql of saved) await db.prepare(sql).run();
  }
}
