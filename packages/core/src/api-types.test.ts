import { describe, expect, it } from "vitest";
import { drilldownForRelation, type DrilldownHint } from "./api-types";

describe("drilldownForRelation", () => {
  it("adds the relation id without changing the hint it came from", () => {
    const hint: DrilldownHint = { path: "/api/bills", query: { status: "open", currency: "EUR" } };
    expect(drilldownForRelation(hint, 12)).toEqual({
      path: "/api/bills",
      query: { status: "open", currency: "EUR", relationId: "12" },
    });
    expect(hint.query).toEqual({ status: "open", currency: "EUR" });
  });
});
