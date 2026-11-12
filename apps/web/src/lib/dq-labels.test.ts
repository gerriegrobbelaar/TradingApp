import { describe, expect, it } from "vitest";
import { reasonText } from "./dq-labels";

describe("reason codes added in the Phase 8 review", () => {
  it("source_never_synced and source_stale have their own sentences", () => {
    expect(reasonText("source_never_synced")).toBe(
      "The Exact sync has never completed for this administration.",
    );
    expect(reasonText("source_stale")).toMatch(/older than 26 hours/);
  });
});
