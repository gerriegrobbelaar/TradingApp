/**
 * A route whose screen chunk cannot be loaded (network error, or a new release replaced the file):
 * the app shell stays, the page shows the retry card instead of a blank page (review N9).
 */
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ADMIN, mockFetch, renderApp } from "./test-utils";

vi.mock("./pages/Settings", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

describe("a lazy route that fails to load", () => {
  it("shows the retry card inside the shell, with the menu still working", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch({ "GET /api/auth/me": () => ({ body: ADMIN }) });
    renderApp("/settings/appearance");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be loaded");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
    expect(document.querySelector("main")?.textContent).toContain("could not be loaded");
  });
});
