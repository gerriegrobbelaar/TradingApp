import { describe, expect, it } from "vitest";
import { EXACT_CLIENT_CORE_VERSION } from "./index";

describe("exact package", () => {
  it("resolves @camelthorn/core through the workspace", () => {
    expect(EXACT_CLIENT_CORE_VERSION).toBe("0.0.0");
  });
});
