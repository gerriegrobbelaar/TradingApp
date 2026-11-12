import { describe, expect, it } from "vitest";
import { paymentsProtocolVersion } from "./index";

describe("paymentsProtocolVersion", () => {
  it("is a stable sha-256 of the rule outputs", () => {
    const v = paymentsProtocolVersion();
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(paymentsProtocolVersion()).toBe(v);
    // Pinned: a change here voids every payments verification mark (docs/decisions/0049).
    expect(v).toBe("985d7b696cb3a7d23db7b12cb1a7eb35e91ccb59335d1119ae64ce0ed40d8a5e");
  });
});
