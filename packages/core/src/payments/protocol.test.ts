import { describe, expect, it } from "vitest";
import { paymentsProtocolVersion } from "./index";

describe("paymentsProtocolVersion", () => {
  it("is a stable sha-256 of the rule outputs", () => {
    const v = paymentsProtocolVersion();
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(paymentsProtocolVersion()).toBe(v);
    // Pinned: a change here voids every payments verification mark (docs/decisions/0049, 0050, 0052: F9a added the checks counterparty_lookup_probe and draft_lifecycle_probe and the block code iban_key_rotated).
    expect(v).toBe("db5c8f2419be48264b6d515a162fc7c13f117bfe038269cf64fda60f4f3cf367");
  });
});
