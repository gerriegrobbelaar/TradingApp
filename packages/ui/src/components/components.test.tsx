import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { Button } from "./Button";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { Segmented } from "./Segmented";
import { Sheet } from "./Sheet";
import { Skeleton } from "./Skeleton";
import { Stamp } from "./Stamp";
import { Switch } from "./Switch";
import { Toast } from "./Toast";

describe("Button", () => {
  it("is a real button, type=button by default, with variant and size classes", () => {
    render(
      <Button variant="primary" size="sm">
        Pay
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Pay" });
    expect(b).toHaveAttribute("type", "button");
    expect(b).toHaveClass("btn", "primary", "sm");
  });

  it("default variant adds no extra class and fires on keyboard Enter", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const b = screen.getByRole("button", { name: "Go" });
    expect(b.className).toBe("btn");
    b.focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Chip and Card", () => {
  it("applies tone class", () => {
    render(<Chip tone="warn">Overdue</Chip>);
    expect(screen.getByText("Overdue")).toHaveClass("chip", "warn");
  });
  it("neutral chip has no tone class; card renders a section", () => {
    render(
      <>
        <Chip>Plain</Chip>
        <Card aria-label="box">x</Card>
      </>,
    );
    expect(screen.getByText("Plain").className).toBe("chip");
    const card = screen.getByLabelText("box");
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveClass("card");
  });
});

describe("Segmented", () => {
  function Harness({ onChange }: { onChange?: (v: string) => void }) {
    const [v, setV] = useState("a");
    return (
      <Segmented
        label="View"
        value={v}
        onChange={(x) => {
          setV(x);
          onChange?.(x);
        }}
        options={[
          { value: "a", label: "Open", count: 3 },
          { value: "b", label: "Done" },
        ]}
      />
    );
  }

  it("marks the selected option with aria-pressed", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-pressed", "false");
  });

  it("changes selection with Tab then Space", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Switch", () => {
  function Harness() {
    const [on, setOn] = useState(false);
    return <Switch label="Four-eyes" checked={on} onCheckedChange={setOn} />;
  }
  it("is a checkbox input with switch role, toggled by Space", async () => {
    render(<Harness />);
    const s = screen.getByRole("switch", { name: "Four-eyes" });
    expect(s.tagName).toBe("INPUT");
    expect(s).toHaveAttribute("type", "checkbox");
    expect(s).not.toBeChecked();
    await userEvent.tab();
    expect(s).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(s).toBeChecked();
    await userEvent.keyboard(" ");
    expect(s).not.toBeChecked();
  });
});

describe("Toast", () => {
  it("calls onUndo and onDismiss when Undo is pressed", async () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    render(<Toast message="Matched 3 lines" onUndo={onUndo} onDismiss={onDismiss} />);
    expect(screen.getByRole("status")).toHaveTextContent("Matched 3 lines");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("has no Undo button without onUndo", () => {
    render(<Toast message="Saved" durationMs={0} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("auto-dismisses after the duration", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Saved" onDismiss={onDismiss} durationMs={1000} />);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not auto-dismiss while Undo has keyboard focus", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="Matched" onUndo={() => {}} onDismiss={onDismiss} durationMs={1000} />);
    act(() => {
      screen.getByRole("button", { name: "Undo" }).focus();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      screen.getByRole("button", { name: "Undo" }).blur();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("Sheet", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open sheet</button>
        <Sheet open={open} title="Receivables" onClose={() => setOpen(false)}>
          <button>First</button>
          <button>Last</button>
        </Sheet>
      </>
    );
  }

  it("renders nothing when closed", () => {
    render(<Sheet open={false} title="T" onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a labelled modal dialog that takes focus", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    const d = screen.getByRole("dialog", { name: "Receivables" });
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(d).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open sheet" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes when the scrim button is clicked", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab focus inside the dialog", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
  });

  it("pulls focus back inside when it has escaped the dialog", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open sheet" });
    await userEvent.click(trigger);
    trigger.focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });
});

describe("Skeleton and Stamp", () => {
  it("skeleton is hidden from assistive tech", () => {
    const { container } = render(<Skeleton width={80} height={10} />);
    const sk = container.querySelector(".sk");
    expect(sk).toHaveAttribute("aria-hidden", "true");
    expect(sk).toHaveStyle({ width: "80px", height: "10px" });
  });

  it("stamp shows relative time with a machine-readable time", () => {
    const then = Date.UTC(2026, 0, 1, 10, 0, 0);
    render(<Stamp at={then} now={then + 5 * 60_000} />);
    const t = screen.getByText("Updated 5 min ago");
    expect(t.tagName).toBe("TIME");
    expect(t).toHaveAttribute("dateTime", "2026-01-01T10:00:00.000Z");
  });

  it("stamp survives an invalid date", () => {
    render(<Stamp at={Number.NaN} />);
    expect(screen.getByText("Not updated yet")).toBeInTheDocument();
  });

  it("stamp refreshes on its own clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    render(<Stamp at={new Date("2026-01-01T10:00:00Z")} />);
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByText("Updated 2 min ago")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
