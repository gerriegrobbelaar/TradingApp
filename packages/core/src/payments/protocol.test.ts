import { describe, expect, it } from "vitest";
import { paymentsProtocolVersion } from "./index";

describe("paymentsProtocolVersion", () => {
  it("is a stable sha-256 of the rule outputs", () => {
    const v = paymentsProtocolVersion();
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(paymentsProtocolVersion()).toBe(v);
    // Pinned: a change here voids every payments verification mark (docs/decisions/0049).
    expect(v).toBe("1c638953d46244610eeb75636e0a41dd8131fdbe2c40f6a9f689d7743be130b7");
  });
});
