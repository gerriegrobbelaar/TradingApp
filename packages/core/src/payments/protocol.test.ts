import { describe, expect, it } from "vitest";
import { paymentsProtocolVersion } from "./index";

describe("paymentsProtocolVersion", () => {
  it("is a stable sha-256 of the rule outputs", () => {
    const v = paymentsProtocolVersion();
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(paymentsProtocolVersion()).toBe(v);
    // Pinned: a change here voids every payments verification mark (docs/decisions/0049, 0050: P9b changed the checklist).
    expect(v).toBe("a1eca92c9b79d6198bfee4d4f329c4067a39c82cefb3c4819fa0f558f33f3668");
  });
});
