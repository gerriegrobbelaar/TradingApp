/**
 * The fail-closed switch for writing matches to Exact (task M7c, ADR 0044; U1 review fixes).
 *
 *  settings.exact.booking_enabled   JSON boolean, default FALSE (a missing row is off). Only the
 *                                   strict JSON `true` counts.
 *  settings.exact.booking_verified  JSON { at, by, note, protocolVersion, checks, createsBankEntries }:
 *                                   an admin recorded that the write path worked on a TEST division,
 *                                   with every check of BOOKING_VERIFY_CHECKS ticked, under the booking
 *                                   mode `createsBankEntries`. It counts only while its protocolVersion
 *                                   equals BOOKING_PROTOCOL_VERSION (a hash computed from the builders,
 *                                   probes, parsers and plan: booking/protocol.ts, so ANY change to what
 *                                   we send invalidates it) and its mode equals the mode in force now.
 *  settings.exact.booking_from      JSON ISO date-time (U1, review B2): only matches created at or after
 *                                   it are booked. Set to NOW whenever booking is enabled.
 *  settings.exact.booking_divisions JSON array of division ids booking may write to. EMPTY (or missing)
 *                                   = no administration allowed.
 *  settings.exact.booking_max_per_run JSON integer 1..10, default 1: matches the job may START per run.
 *
 * Booking runs only when no RUN blocker is left (`RUN_BLOCKERS`): the switch is on, the verification
 * is current and was done in the booking mode that is in force now, an active Exact connection
 * exists, the Revolut connection has decided who creates the bank entries and at least one division
 * is allowed. The ExactGate re-checks all of it at call time (exact/write-policy.ts), the executor
 * checks it again. `control_accounts_missing` and `journal_unmapped` only block ENABLING: at run
 * time they defer the single match (matches.booking_deferred_code), they never stop the job.
 */
import { BOOKING_VERIFY_CHECKS } from "@camelthorn/core";
import { BOOKING_PROTOCOL_VERSION } from "./protocol";

export const SETTING_ENABLED = "exact.booking_enabled";
export const SETTING_VERIFIED = "exact.booking_verified";
export const SETTING_FROM = "exact.booking_from";
export const SETTING_DIVISIONS = "exact.booking_divisions";
export const SETTING_MAX_PER_RUN = "exact.booking_max_per_run";

export const DEFAULT_MAX_PER_RUN = 1;
export const MAX_MAX_PER_RUN = 10;
/** booking_from may be at most this far in the future (clock differences, not a schedule). */
export const BOOKING_FROM_MAX_FUTURE_MS = 24 * 3600_000;

/** The typed phrases (sent as `confirm`): ONE source for worker, web and tests (core). */
export {
  BOOKING_ENABLE_PHRASE as ENABLE_PHRASE,
  BOOKING_VERIFY_PHRASE as VERIFY_PHRASE,
} from "@camelthorn/core";

export type BookingBlocker =
  | "not_verified"
  | "protocol_changed"
  | "mode_changed"
  | "bank_entries_undecided"
  | "no_exact_connection"
  | "no_division_allowed"
  | "control_accounts_missing"
  | "journal_unmapped"
  | "writes_disabled";

/** Blockers that stop a RUN (and every write at the gate). The others only stop enabling. */
export const RUN_BLOCKERS: readonly BookingBlocker[] = [
  "not_verified",
  "protocol_changed",
  "mode_changed",
  "bank_entries_undecided",
  "no_exact_connection",
  "no_division_allowed",
  "writes_disabled",
];

export interface VerificationMark {
  at: string;
  by: string;
  note: string;
  protocolVersion: string;
  /** The ticked checks: always exactly BOOKING_VERIFY_CHECKS. */
  checks: string[];
  /** The booking mode the verification was done under; valid only while it equals the current one. */
  createsBankEntries: boolean;
}

export interface BookingState {
  enabled: boolean;
  verified: VerificationMark | null;
  protocolVersion: string;
  protocolChanged: boolean;
  /** null = the Revolut connection has not decided (or does not exist). */
  createsBankEntries: boolean | null;
  exactActive: boolean;
  /** The verification was done under another booking mode than the one in force now. */
  modeChanged: boolean;
  /** ISO watermark; null = booking was never enabled. */
  bookingFrom: string | null;
  /** Division ids booking may write to. */
  divisions: number[];
  maxPerRun: number;
  /** A live, not-booked match sits on an account whose control account for its kind is unset. */
  controlAccountsMissing: boolean;
  /** A live, not-booked match whose bank account has no administration mapping. */
  journalUnmapped: boolean;
}

/** Exactly the required check codes: every one, nothing else, no duplicates (order is free). */
export function sameChecks(list: readonly unknown[]): boolean {
  const need: readonly string[] = BOOKING_VERIFY_CHECKS;
  if (list.length !== need.length) return false;
  const seen = new Set<unknown>(list);
  return seen.size === need.length && need.every((c) => seen.has(c));
}

function parseVerified(raw: string | null): VerificationMark | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const checks = v["checks"];
    if (
      typeof v["at"] === "string" &&
      typeof v["by"] === "string" &&
      typeof v["note"] === "string" &&
      typeof v["protocolVersion"] === "string" &&
      /^[0-9a-f]{64}$/.test(v["protocolVersion"]) &&
      typeof v["createsBankEntries"] === "boolean" &&
      Array.isArray(checks) &&
      sameChecks(checks)
    ) {
      return {
        at: v["at"],
        by: v["by"],
        note: v["note"],
        protocolVersion: v["protocolVersion"],
        checks: checks as string[],
        createsBankEntries: v["createsBankEntries"],
      };
    }
  } catch {
    // unreadable: not verified
  }
  return null;
}

function parseIso(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "string") return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

function parseDivisions(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const ids = v.filter((x): x is number => Number.isSafeInteger(x) && (x as number) >= 1);
    return ids.length === v.length ? [...new Set(ids)].sort((a, b) => a - b) : [];
  } catch {
    return [];
  }
}

function parseMax(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_PER_RUN;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_MAX_PER_RUN
      ? v
      : DEFAULT_MAX_PER_RUN;
  } catch {
    return DEFAULT_MAX_PER_RUN;
  }
}

/** One batch of reads. Anything unreadable counts as off / not verified / nothing allowed. */
export async function loadBookingState(db: D1Database): Promise<BookingState> {
  const [settings, revolut, exact, config] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT key, value_json FROM settings WHERE key IN (?1, ?2, ?3, ?4, ?5)")
      .bind(
        SETTING_ENABLED,
        SETTING_VERIFIED,
        SETTING_FROM,
        SETTING_DIVISIONS,
        SETTING_MAX_PER_RUN,
      ),
    db.prepare(
      `SELECT creates_bank_entries, bank_entries_decided_at FROM connections
       WHERE kind = 'revolut' ORDER BY id LIMIT 1`,
    ),
    db.prepare("SELECT status FROM connections WHERE kind = 'exact' ORDER BY id LIMIT 1"),
    // Configuration gaps over the live, not-booked matches (advisory: they block enabling only).
    db.prepare(
      `SELECT
         EXISTS (
           SELECT 1 FROM matches m
             JOIN bank_transactions t ON t.id = m.bank_transaction_id
             JOIN bank_account_exact_map mp ON mp.bank_account_id = t.bank_account_id
             JOIN match_allocations a ON a.match_id = m.id
             JOIN open_items oi ON oi.id = a.open_item_id
           WHERE m.undone_at IS NULL AND m.exact_state = 'not_booked' AND m.review_reason IS NULL
             AND ((oi.kind = 'invoice' AND (mp.receivable_gl_account_code IS NULL
                                            OR TRIM(mp.receivable_gl_account_code) = ''))
               OR (oi.kind = 'bill' AND (mp.payable_gl_account_code IS NULL
                                         OR TRIM(mp.payable_gl_account_code) = '')))) AS control_missing,
         EXISTS (
           SELECT 1 FROM matches m
             JOIN bank_transactions t ON t.id = m.bank_transaction_id
             LEFT JOIN bank_account_exact_map mp ON mp.bank_account_id = t.bank_account_id
                                                AND mp.division_id = m.division_id
           WHERE m.undone_at IS NULL AND m.exact_state = 'not_booked' AND m.review_reason IS NULL
             AND (mp.id IS NULL OR TRIM(mp.journal_code) = '')) AS journal_unmapped`,
    ),
  ]);
  const byKey = new Map(
    (settings?.results ?? []).map((r) => [String(r["key"]), String(r["value_json"])]),
  );
  const enabled = byKey.get(SETTING_ENABLED) === "true";
  const verified = parseVerified(byKey.get(SETTING_VERIFIED) ?? null);
  const rev = revolut?.results?.[0];
  const createsBankEntries =
    rev === undefined || rev["bank_entries_decided_at"] == null
      ? null
      : rev["creates_bank_entries"] === 1;
  const cfg = config?.results?.[0];
  return {
    enabled,
    verified,
    protocolVersion: BOOKING_PROTOCOL_VERSION,
    protocolChanged: verified !== null && verified.protocolVersion !== BOOKING_PROTOCOL_VERSION,
    createsBankEntries,
    exactActive: exact?.results?.[0]?.["status"] === "active",
    modeChanged:
      verified !== null &&
      createsBankEntries !== null &&
      verified.createsBankEntries !== createsBankEntries,
    bookingFrom: parseIso(byKey.get(SETTING_FROM)),
    divisions: parseDivisions(byKey.get(SETTING_DIVISIONS)),
    maxPerRun: parseMax(byKey.get(SETTING_MAX_PER_RUN)),
    controlAccountsMissing: cfg?.["control_missing"] === 1,
    journalUnmapped: cfg?.["journal_unmapped"] === 1,
  };
}

/** Codes of what stops booking right now (empty = booking may run). Order is stable. */
export function blockersOf(s: BookingState): BookingBlocker[] {
  const out: BookingBlocker[] = [];
  if (s.verified === null) out.push("not_verified");
  else if (s.protocolChanged) out.push("protocol_changed");
  else if (s.modeChanged) out.push("mode_changed");
  if (s.createsBankEntries === null) out.push("bank_entries_undecided");
  if (!s.exactActive) out.push("no_exact_connection");
  if (s.divisions.length === 0) out.push("no_division_allowed");
  if (s.controlAccountsMissing) out.push("control_accounts_missing");
  if (s.journalUnmapped) out.push("journal_unmapped");
  if (!s.enabled) out.push("writes_disabled");
  return out;
}

/** The blockers that stop a run (a subset of `blockersOf`). */
export const runBlockersOf = (s: BookingState): BookingBlocker[] =>
  blockersOf(s).filter((b) => RUN_BLOCKERS.includes(b));

/**
 * The switch is on AND the verification is current AND was done under the mode in force now: what
 * the gate re-reads at call time. (The allow-list and the connection are checked by the gate too.)
 */
export function writesPermitted(
  s: Pick<BookingState, "enabled" | "verified"> & Partial<Pick<BookingState, "modeChanged">>,
): boolean {
  return (
    s.enabled &&
    s.verified !== null &&
    s.verified.protocolVersion === BOOKING_PROTOCOL_VERSION &&
    s.modeChanged !== true
  );
}

/** Everything the executor needs: the switch, the verification, the connections, the allow-list. */
export const bookingMayRun = (s: BookingState): boolean => runBlockersOf(s).length === 0;
