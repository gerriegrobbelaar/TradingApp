import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button, readStoredTheme } from "@camelthorn/ui";

describe("@camelthorn/ui from apps/web", () => {
  it("imports components and theme helpers", () => {
    render(<Button>Pay</Button>);
    expect(screen.getByRole("button", { name: "Pay" }).className).toBe("btn");
    expect(readStoredTheme(undefined)).toBe("auto");
  });
});
