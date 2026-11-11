/**
 * Review S2: a screen that throws while rendering must not blank the shell. The page boundary
 * keeps the top menu, skip link and footer; the sheet boundary keeps the page and the sheet's
 * own close controls. The fallback shows no error text, and only the error NAME is logged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoot } from "react-dom/client";
import { configureAxe } from "vitest-axe";
import { Sheet } from "@camelthorn/ui";
import { nav } from "./api";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { rootErrorHandlers } from "./lib/root-errors";
import { ONE_DIVISION, listResponse, row } from "./test-fixtures";
import { VIEWER, mockFetch, renderApp } from "./test-utils";
import { fxRates } from "./test-fixtures-fx";

vi.mock("./pages/Overview", () => ({
  Overview: () => {
    throw new TypeError("secret amount 1234 for NL91ABNA0417164300");
  },
}));

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const base = () => ({
  "GET /api/auth/me": () => ({ body: VIEWER }),
  "GET /api/divisions": () => ({ body: ONE_DIVISION }),
  "GET /api/fx/rates": () => ({ body: fxRates() }),
  "GET /api/invoices": () => ({ body: listResponse([row({ id: 1 })]) }),
});

afterEach(() => vi.restoreAllMocks());

describe("page boundary", () => {
  it("a throwing page leaves the menu, skip link and footer working, with a calm fallback", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(base());
    const { container } = renderApp("/overview");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Something went wrong on this page. Reload, or go back.");
    // the shell is still there
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toBeTruthy();
    expect(screen.getByText(/Signed in as/)).toBeTruthy();
    // no error text, stack or data on screen
    expect(document.body.textContent).not.toMatch(/secret|1234|NL91|TypeError|at \w+ \(/);
    // logged once, by name only
    const lines = logged.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith("ui render error"));
    expect(lines).toEqual(["ui render error: TypeError"]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Reload and Go back are real buttons that work from the keyboard", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.spyOn(nav, "reload").mockImplementation(() => undefined);
    const back = vi.spyOn(nav, "back").mockImplementation(() => undefined);
    mockFetch(base());
    renderApp("/overview");
    const alert = await screen.findByRole("alert");
    const user = userEvent.setup();
    const btn = within(alert).getByRole("button", { name: "Reload" });
    btn.focus();
    await user.keyboard("{Enter}");
    expect(reload).toHaveBeenCalledTimes(1);
    await user.click(within(alert).getByRole("button", { name: "Go back" }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("another page works after the broken one (the boundary resets with the route)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(base());
    renderApp("/overview");
    await screen.findByRole("alert");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: /^Invoices/ }));
    await screen.findByRole("table", { name: "Invoices" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("what reaches the console (root handlers as in main.tsx)", () => {
  it("logs the error name once and never the message, stack or component stack", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host, rootErrorHandlers);
    function Bad(): never {
      throw new TypeError("secret amount 1234 for NL91ABNA0417164300");
    }
    await act(async () => {
      root.render(
        <PageErrorBoundary path="/x">
          <Bad />
        </PageErrorBoundary>,
      );
    });
    expect(host.textContent).toContain("Something went wrong on this page.");
    expect(logged.mock.calls.map((c) => c.map(String).join(" "))).toEqual([
      "ui render error: TypeError",
    ]);
    // an error nothing caught: name only as well
    rootErrorHandlers.onUncaughtError(new RangeError("secret"));
    expect(String(logged.mock.calls.at(-1)?.[0])).toBe("ui uncaught error: RangeError");
    await act(async () => root.unmount());
    host.remove();
  });
});

describe("sheet boundary", () => {
  function Boom(): never {
    throw new RangeError("private detail");
  }

  it("a throwing sheet body leaves the page, the title and Escape working", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onClose = vi.fn();
    render(
      <div>
        <p>page behind</p>
        <Sheet open title="Details" onClose={onClose}>
          <Boom />
        </Sheet>
      </div>,
    );
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(within(dialog).getByRole("alert").textContent).toContain("Something went wrong");
    expect(screen.getByText("page behind")).toBeTruthy();
    expect(dialog.textContent).not.toContain("private detail");
    expect(logged.mock.calls.map((c) => String(c[0]))).toContain("ui render error: RangeError");
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
