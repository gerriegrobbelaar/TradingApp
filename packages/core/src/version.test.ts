import { describe, expect, it } from "vitest";
import { describeCore } from "./version";

describe("describeCore", () => {
  it("includes the package name and version", () => {
    expect(describeCore()).toBe("@camelthorn/core 0.0.0");
  });
});
