/**
 * Review of T2: the sheet's error boundary must not break the sheet's own keyboard contract
 * (focus trap, Escape, focus back to the opener) and must clear when the sheet shows something
 * else or is closed and opened again.
 */
import { useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

afterEach(() => vi.restoreAllMocks());

function Boom({ when }: { when: boolean }) {
  if (when) throw new Error("private");
  return (
    <button type="button" autoFocus>
      inside
    </button>
  );
}

function Host({ initialBroken = true }: { initialBroken?: boolean }) {
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState("A");
  const [broken, setBroken] = useState(initialBroken);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      <button type="button" onClick={() => setBroken(true)}>
        break
      </button>
      {/* outside the sheet, like a J/K shortcut that moves to the next item */}
      <button type="button" onClick={() => setItem("B")}>
        next item
      </button>
      <Sheet open={open} title={`Item ${item}`} onClose={() => setOpen(false)}>
        <Boom when={broken && item === "A"} />
      </Sheet>
    </>
  );
}

describe("Sheet with a body that throws", () => {
  it("keeps the focus trap: Tab and Shift+Tab stay on the fallback's Close button", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Host />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "opener" }));
    const dialog = screen.getByRole("dialog", { name: "Item A" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
  });

  it("Escape closes it and focus returns to the opener", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Host />);
    const user = userEvent.setup();
    const opener = screen.getByRole("button", { name: "opener" });
    await user.click(opener);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("is clear again after closing and opening the sheet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Toggle() {
      const [open, setOpen] = useState(true);
      const [broken, setBroken] = useState(true);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setBroken(false);
              setOpen(true);
            }}
          >
            reopen
          </button>
          <Sheet open={open} title="Same title" onClose={() => setOpen(false)}>
            <Boom when={broken} />
          </Sheet>
        </>
      );
    }
    render(<Toggle />);
    const user = userEvent.setup();
    expect(screen.getByRole("alert")).toBeTruthy();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "reopen" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "inside" })).toBeTruthy();
  });

  it("moves focus to Close when the broken body took the focus with it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Host initialBroken={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "opener" }));
    const dialog = screen.getByRole("dialog");
    const inside = within(dialog).getByRole("button", { name: "inside" });
    inside.focus();
    // break the body from outside while focus is inside it
    act(() => {
      screen.getByRole("button", { name: "break", hidden: true }).click();
    });
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
  });

  it("clears when the sheet shows another item (a new title)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Host />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "opener" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    act(() => {
      screen.getByRole("button", { name: "next item", hidden: true }).click();
    });
    const dialog = screen.getByRole("dialog", { name: "Item B" });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "inside" })).toBeTruthy();
  });
});
