/**
 * The fail-closed switch for writing matches to Exact (task M7c, ADR 0043).
 *
 *  settings.exact.booking_enabled   JSON boolean, default FALSE (a missing row is off). Only the
 *                                   strict JSON `true` counts.
 *  settings.exact.booking_verified  JSON { at, by, note, protocolVersion }: an admin recorded that
 *                                   the write path worked on a TEST division. It counts only while its
 *                                   protocolVersion equals BOOKING_PROTOCOL_VERSION (a hash computed
 *                                   from the payload builders in packages/exact), so ANY change to
 *                                   what we send invalidates it.
 *
 * Booking runs only when ALL of these hold (`bookingBlockers` lists what is missing): the switch is
 * on, the verification is current, an active Exact connection exists and the Revolut connection has
 * decided whether this app creates the bank entries. The ExactGate re-checks the switch and the
 * verification at call time (exact/write-policy.ts), the executor checks them again.
 */
import { BOOKING_PROTOCOL_VERSION } from "@camelthorn/exact";

export const SETTING_ENABLED = "exact.booking_enabled";
export const SETTING_VERIFIED = "exact.booking_verified";

/** Typed by an admin to switch booking on. */
export const ENABLE_PHRASE = "ENABLE EXACT BOOKING";
/** Typed (sent as `confirm`) to record the verification. */
export const VERIFY_PHRASE = "I VERIFIED THE EXACT WRITE PATH ON A TEST DIVISION";

export type BookingBlocker =
  | "not_verified"
  | "protocol_changed"
  | "bank_entries_undecided"
  | "no_exact_connection"
  | "writes_disabled";

export interface VerificationMark {
  at: string;
  by: string;
  note: string;
  protocolVersion: string;
}

export interface BookingState {
  enabled: boolean;
  verified: VerificationMark | null;
  protocolVersion: string;
  protocolChanged: boolean;
  /** null = the Revolut connection has not decided (or does not exist). */
  createsBankEntries: boolean | null;
  exactActive: boolean;
}

function parseVerified(raw: string | null): VerificationMark | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof v["at"] === "string" &&
      typeof v["by"] === "string" &&
      typeof v["note"] === "string" &&
      typeof v["protocolVersion"] === "string" &&
      /^[0-9a-f]{64}$/.test(v["protocolVersion"])
    ) {
      return {
        at: v["at"],
        by: v["by"],
        note: v["note"],
        protocolVersion: v["protocolVersion"],
      };
    }
  } catch {
    // unreadable: not verified
  }
  return null;
}

/** One batch of three reads. Anything unreadable counts as off / not verified. */
export async function loadBookingState(db: D1Database): Promise<BookingState> {
  const [settings, revolut, exact] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT key, value_json FROM settings WHERE key IN (?1, ?2)")
      .bind(SETTING_ENABLED, SETTING_VERIFIED),
    db.prepare(
      `SELECT creates_bank_entries, bank_entries_decided_at FROM connections
       WHERE kind = 'revolut' ORDER BY id LIMIT 1`,
    ),
    db.prepare("SELECT status FROM connections WHERE kind = 'exact' ORDER BY id LIMIT 1"),
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
  return {
    enabled,
    verified,
    protocolVersion: BOOKING_PROTOCOL_VERSION,
    protocolChanged: verified !== null && verified.protocolVersion !== BOOKING_PROTOCOL_VERSION,
    createsBankEntries,
    exactActive: exact?.results?.[0]?.["status"] === "active",
  };
}

/** Codes of what stops booking right now (empty = booking may run). Order is stable. */
export function blockersOf(s: BookingState): BookingBlocker[] {
  const out: BookingBlocker[] = [];
  if (s.verified === null) out.push("not_verified");
  else if (s.protocolChanged) out.push("protocol_changed");
  if (s.createsBankEntries === null) out.push("bank_entries_undecided");
  if (!s.exactActive) out.push("no_exact_connection");
  if (!s.enabled) out.push("writes_disabled");
  return out;
}

/** The switch is on AND the verification is current: what the gate re-reads at call time. */
export function writesPermitted(s: Pick<BookingState, "enabled" | "verified">): boolean {
  return (
    s.enabled && s.verified !== null && s.verified.protocolVersion === BOOKING_PROTOCOL_VERSION
  );
}

/** Everything the executor needs: the switch, the verification, the connections. */
export const bookingMayRun = (s: BookingState): boolean => blockersOf(s).length === 0;
