import { describe, expect, it } from "vitest";
import { reasonText } from "./dq-labels";

describe("reasonText for source freshness (review V1 S5)", () => {
  it("explains a source that was never read or is too old, and where to look", () => {
    expect(reasonText("source_never_synced")).toMatch(/never been fully read/);
    expect(reasonText("source_stale")).toMatch(/too old/);
    for (const r of ["source_never_synced", "source_stale"]) {
      expect(reasonText(r)).toMatch(/Settings, Schedules/);
      expect(reasonText(r)).not.toMatch(/Reason:/);
    }
  });
});
