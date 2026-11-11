/**
 * BOOKING_PROTOCOL_VERSION of the worker (review M7c): one hash over the Exact package's version AND
 * the worker's plan, error classification and limits. A change to any of them must invalidate the
 * "write path verified" mark.
 */
import { BOOKING_PROTOCOL_VERSION as EXACT_VERSION } from "@camelthorn/exact";
import { describe, expect, it } from "vitest";
import { BOOKING_PROTOCOL_VERSION, workerProtocolCanonical } from "../src/booking/protocol";
import { loadBookingState } from "../src/booking/settings";
import { db } from "./booking-helpers";

describe("worker BOOKING_PROTOCOL_VERSION", () => {
  it("is a sha-256 that differs from the Exact package's own and is what the settings compare", async () => {
    expect(BOOKING_PROTOCOL_VERSION).toMatch(/^[0-9a-f]{64}$/);
    expect(BOOKING_PROTOCOL_VERSION).not.toBe(EXACT_VERSION);
    expect((await loadBookingState(db)).protocolVersion).toBe(BOOKING_PROTOCOL_VERSION);
  });

  it("covers the Exact version, the plan's signs and refusals, the error classes and the limits", () => {
    const c = workerProtocolCanonical();
    expect(c).toContain(EXACT_VERSION);
    // the receivable sample: item +1000.00, bank line -1000.00 (a flipped sign changes the text)
    expect(c).toContain(
      "<MatchLine><EntryNumber>20</EntryNumber><Amount>1000.00</Amount></MatchLine><MatchLine><EntryNumber>999</EntryNumber><Amount>-1000.00</Amount></MatchLine>",
    );
    // the supplier bill sample: bill -500.00, bank line +500.00
    expect(c).toContain("<EntryNumber>20</EntryNumber><Amount>-500.00</Amount>");
    for (const refusal of [
      "partial_match_not_supported_v1",
      "fx_not_supported_v1",
      "mixed_item_kinds",
      "multiple_relations",
      "bad_amount",
      "mixed_currency",
    ]) {
      expect(c).toContain(refusal);
    }
    expect(c).toContain('"kind":"unknown","code":"gate_error"');
    expect(c).toContain('"kind":"unknown","code":"auth_after_send"');
    expect(c).toContain('"DAILY_BOOKING_CALL_CAP":400');
    expect(c).not.toMatch(/NL91ABNA0417164300/);
  });

  it("covers what decides whether something is sent at all (U1): deferrals, preflight, fees, mode, canary", () => {
    const c = workerProtocolCanonical();
    for (const part of [
      "control_account_unknown", // deferral codes
      "bank_balance_unknown",
      "already_settled_in_exact", // preflight codes
      "items_changed",
      "preflight_inconclusive",
      "fee_not_supported_v1", // the fee rule
      "mode_mismatch", // the mode rule
      '"open_as_expected"', // the verdicts on samples
      '"already_settled"',
      '"changed"',
      '"MAX_CANDIDATES_SCANNED":25', // the new limits
      '"DEFER_RECHECK_MS":1800000',
    ]) {
      expect(c, part).toContain(part);
    }
  });

  it("is pinned: a deliberate change must update this value AND re-verify on a test division", () => {
    expect(BOOKING_PROTOCOL_VERSION).toBe(PINNED);
  });
});

const PINNED = "924f9b963ea6162749dec23887cc55efb20c6b245ca94a3b3ddde99572ac9997";
