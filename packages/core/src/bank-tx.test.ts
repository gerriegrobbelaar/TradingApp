import { describe, expect, it } from "vitest";
import {
  compactIban,
  decideLegUpdate,
  FINAL_BANK_TX_STATES,
  isFinalBankTxState,
  type StoredBankTxState,
} from "./bank-tx";

const ALL: StoredBankTxState[] = [
  "created",
  "pending",
  "completed",
  "declined",
  "failed",
  "reverted",
  "unknown",
];

const T1 = Date.parse("2026-05-01T10:00:00Z");
const T2 = T1 + 1000;

const rk = (s: StoredBankTxState): StoredBankTxState => (s === "created" ? "pending" : s);

/** The documented table, written out independently of the implementation. */
function expectedApply(a: StoredBankTxState, b: StoredBankTxState): boolean {
  const A = rk(a);
  const B = rk(b);
  if (B === "unknown") return A === "unknown";
  if (A === "unknown") return true;
  if (A === "pending") return true;
  if (B === "pending") return false; // final never goes back
  if (A === B) return true;
  return A === "completed" && B === "reverted";
}

describe("decideLegUpdate", () => {
  it("applies when nothing is stored", () => {
    expect(decideLegUpdate(null, { state: "unknown", updatedAtMs: null })).toEqual({
      apply: true,
      reason: "new",
    });
  });

  it("covers every ordered pair of states (equal timestamps)", () => {
    for (const a of ALL) {
      for (const b of ALL) {
        const d = decideLegUpdate({ state: a, updatedAtMs: T1 }, { state: b, updatedAtMs: T1 });
        expect(d.apply, `${a} -> ${b}`).toBe(expectedApply(a, b));
      }
    }
  });

  it("a final state is never moved back to pending, whatever the timestamps", () => {
    for (const f of FINAL_BANK_TX_STATES) {
      for (const at of [null, T1 - 5000, T1, T2]) {
        expect(
          decideLegUpdate({ state: f, updatedAtMs: T1 }, { state: "pending", updatedAtMs: at }),
        ).toEqual({ apply: false, reason: "regress_blocked" });
      }
    }
  });

  it("an unknown state never overwrites a known one", () => {
    for (const s of ALL.filter((x) => x !== "unknown")) {
      expect(
        decideLegUpdate({ state: s, updatedAtMs: T1 }, { state: "unknown", updatedAtMs: T2 }),
      ).toEqual({ apply: false, reason: "unknown_ignored" });
    }
  });

  it("a newer updated_at wins and an older one is ignored for the same state", () => {
    expect(
      decideLegUpdate({ state: "pending", updatedAtMs: T2 }, { state: "pending", updatedAtMs: T1 }),
    ).toEqual({ apply: false, reason: "older" });
    expect(
      decideLegUpdate({ state: "pending", updatedAtMs: T1 }, { state: "pending", updatedAtMs: T2 })
        .apply,
    ).toBe(true);
    expect(
      decideLegUpdate(
        { state: "completed", updatedAtMs: T2 },
        { state: "completed", updatedAtMs: T1 },
      ).apply,
    ).toBe(false);
    // Missing timestamps count as not older.
    expect(
      decideLegUpdate(
        { state: "completed", updatedAtMs: null },
        { state: "completed", updatedAtMs: T1 },
      ).apply,
    ).toBe(true);
  });

  it("completed to reverted is legal, but not with an older timestamp; other final changes conflict", () => {
    expect(
      decideLegUpdate(
        { state: "completed", updatedAtMs: T1 },
        { state: "reverted", updatedAtMs: T2 },
      ),
    ).toEqual({ apply: true, reason: "forward" });
    expect(
      decideLegUpdate(
        { state: "completed", updatedAtMs: T2 },
        { state: "reverted", updatedAtMs: T1 },
      ),
    ).toEqual({ apply: false, reason: "older" });
    expect(
      decideLegUpdate(
        { state: "failed", updatedAtMs: T1 },
        { state: "completed", updatedAtMs: T2 },
      ),
    ).toEqual({ apply: false, reason: "conflict_blocked" });
    expect(
      decideLegUpdate(
        { state: "reverted", updatedAtMs: T1 },
        { state: "completed", updatedAtMs: T2 },
      ).reason,
    ).toBe("conflict_blocked");
  });

  it("an unknown stored state is refreshed by an unknown one only when not older", () => {
    expect(
      decideLegUpdate({ state: "unknown", updatedAtMs: T2 }, { state: "unknown", updatedAtMs: T1 })
        .apply,
    ).toBe(false);
    expect(
      decideLegUpdate({ state: "unknown", updatedAtMs: T1 }, { state: "unknown", updatedAtMs: T2 })
        .apply,
    ).toBe(true);
  });
});

describe("helpers", () => {
  it("knows final states", () => {
    expect(isFinalBankTxState("completed")).toBe(true);
    expect(isFinalBankTxState("pending")).toBe(false);
    expect(isFinalBankTxState("created")).toBe(false);
    expect(isFinalBankTxState("unknown")).toBe(false);
  });
  it("compacts IBANs", () => {
    expect(compactIban("nl91 abna 0417 1643 00")).toBe("NL91ABNA0417164300");
    expect(compactIban("  ")).toBeNull();
    expect(compactIban(undefined)).toBeNull();
    expect(compactIban(null)).toBeNull();
  });
});
