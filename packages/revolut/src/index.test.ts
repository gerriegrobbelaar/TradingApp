import { describe, expect, it } from "vitest";
import { REVOLUT_CLIENT_CORE_VERSION } from "./index";

describe("revolut package", () => {
  it("resolves @camelthorn/core through the workspace", () => {
    expect(REVOLUT_CLIENT_CORE_VERSION).toBe("0.0.0");
  });
});
