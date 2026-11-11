import { describe, expect, it } from "vitest";
import { drilldownForRelation, type DrilldownHint, type MatchCreateRequest } from "./api-types";

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

describe("matching api types", () => {
  it("a manual match request names either allocations or a ledger account", () => {
    const byItems: MatchCreateRequest = {
      transactionId: 1,
      allocations: [{ openItemId: 2, allocatedMinor: 100 }],
    };
    const byLedger: MatchCreateRequest = { transactionId: 1, ledgerAccountCode: "4500" };
    expect(Object.keys(byItems).sort()).toEqual(["allocations", "transactionId"]);
    expect(Object.keys(byLedger).sort()).toEqual(["ledgerAccountCode", "transactionId"]);
  });
});
