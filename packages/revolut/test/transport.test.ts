import { describe, expect, it } from "vitest";
import {
  JOB_ID_RE,
  RevolutApiError,
  RevolutAuthError,
  RevolutBudgetExhaustedError,
  RevolutRateLimitedError,
} from "../src/transport";

describe("transport errors", () => {
  it("carry their fields and names", () => {
    const b = new RevolutBudgetExhaustedError("job-1");
    expect(b).toMatchObject({ jobId: "job-1", name: "RevolutBudgetExhaustedError" });
    expect(b.message).toContain("job-1");
    expect(new RevolutRateLimitedError(5)).toMatchObject({
      retryAfterMs: 5,
      name: "RevolutRateLimitedError",
    });
    expect(new RevolutAuthError().name).toBe("RevolutAuthError");
    const a = new RevolutApiError(400, "m", "c");
    expect(a).toMatchObject({ status: 400, code: "c" });
    expect(new RevolutApiError(500, "m").code).toBeUndefined();
  });

  it("job ids are short and plain", () => {
    expect(JOB_ID_RE.test("revolut-sync:1")).toBe(true);
    expect(JOB_ID_RE.test("")).toBe(false);
    expect(JOB_ID_RE.test("a b")).toBe(false);
  });
});
