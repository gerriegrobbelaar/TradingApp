import { describe, expect, it } from "vitest";
import { UI_PACKAGE } from "./index";

describe("ui package", () => {
  it("exports its name", () => {
    expect(UI_PACKAGE).toBe("@camelthorn/ui");
  });
});
