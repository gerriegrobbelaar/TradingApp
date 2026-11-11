/**
 * Review M7d: a sheet with typed, unsaved input asks before Escape (or the scrim, or an inner Close
 * via useSheetClose) throws it away; stacked sheets close one at a time.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sheet, useSheetClose } from "./Sheet";

function InnerClose() {
  const close = useSheetClose();
  return (
    <button type="button" onClick={close}>
      Inner close
    </button>
  );
}

function Editor() {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState("");
  return (
    <>
      <p data-testid="state">{open ? "open" : "closed"}</p>
      <Sheet open={open} title="Allocate" onClose={() => setOpen(false)} dirty={text !== ""}>
        <label>
          Amount
          <input value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <InnerClose />
      </Sheet>
    </>
  );
}

describe("Sheet with unsaved input", () => {
  it("closes on Escape at once when nothing was typed", async () => {
    render(<Editor />);
    screen.getByLabelText("Amount").focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
  });

  it("asks first when Escape is pressed while typing; Keep editing keeps the text and focus", async () => {
    render(<Editor />);
    const input = screen.getByLabelText("Amount");
    await userEvent.type(input, "12,50");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByTestId("state")).toHaveTextContent("open");
    const ask = screen.getByRole("alertdialog", { name: /Discard what you typed/ });
    expect(ask).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByLabelText("Amount")).toHaveValue("12,50");
    expect(screen.getByLabelText("Amount")).toHaveFocus();
  });

  it("a second Escape answers Keep editing; Discard closes", async () => {
    render(<Editor />);
    await userEvent.type(screen.getByLabelText("Amount"), "1");
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("state")).toHaveTextContent("open");
    await userEvent.click(screen.getByRole("button", { name: "Inner close" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard and close" }));
    expect(screen.getByTestId("state")).toHaveTextContent("closed");
  });

  it("the scrim asks too", async () => {
    render(<Editor />);
    await userEvent.type(screen.getByLabelText("Amount"), "1");
    const scrim = document.querySelector<HTMLButtonElement>(".scrim");
    expect(scrim).not.toBeNull();
    await userEvent.click(scrim as HTMLButtonElement);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByTestId("state")).toHaveTextContent("open");
  });
});

function Stacked() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(false);
  return (
    <>
      <p data-testid="outer">{outer ? "open" : "closed"}</p>
      <Sheet open={outer} title="Outer" onClose={() => setOuter(false)}>
        <button type="button" onClick={() => setInner(true)}>
          Open inner
        </button>
      </Sheet>
      <Sheet open={inner} title="Inner" onClose={() => setInner(false)}>
        <button type="button">Only</button>
      </Sheet>
    </>
  );
}

describe("stacked sheets", () => {
  it("Escape closes only the top sheet, then the next", async () => {
    render(<Stacked />);
    await userEvent.click(screen.getByRole("button", { name: "Open inner" }));
    expect(screen.getByRole("dialog", { name: "Inner" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(screen.getByTestId("outer")).toHaveTextContent("open");
    expect(screen.getByRole("button", { name: "Open inner" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByTestId("outer")).toHaveTextContent("closed");
  });
});
