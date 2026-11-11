import { norm } from "../test-norm";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { configureAxe } from "vitest-axe";
import { DataTable, LoadMore, type Column } from "./DataTable";
import { DrillSheet } from "./DrillSheet";
import { FilterBar } from "./FilterBar";
import { FreshnessStamp } from "./FreshnessStamp";
import { Money, MoneyByCurrency } from "./Money";
import { safeExactLink } from "./OpenItemDetailBody";
import { FRESH, NEVER, STALE } from "../test-fixtures";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

describe("Money", () => {
  it("labels a credit for screen readers and shows the minus", () => {
    const { container } = render(<Money minor={-2500} currency="EUR" />);
    expect(norm(container.textContent)).toBe("€ -25,00 credit");
    expect(container.querySelector(".sr-only")?.textContent).toBe(" credit");
    expect(container.querySelector(".num")).not.toBeNull();
  });

  it("does not mark a positive amount or zero as credit", () => {
    const { container } = render(
      <>
        <Money minor={0} currency="EUR" />
        <Money minor={5} currency="EUR" />
      </>,
    );
    expect(container.querySelector(".sr-only")).toBeNull();
  });
});

describe("MoneyByCurrency", () => {
  it("stacks one line per currency and never adds across currencies", async () => {
    const { container } = render(
      <MoneyByCurrency
        totals={[
          { currency: "EUR", minor: 1000 },
          { currency: "USD", minor: 2000 },
          { currency: "JPY", minor: 3000, note: "2 items" },
        ]}
      />,
    );
    const lines = screen.getAllByRole("listitem");
    expect(lines).toHaveLength(3);
    expect(norm(lines[0]?.textContent ?? "")).toContain("€ 10,00");
    expect(lines[1]?.textContent).toContain("USD");
    expect(lines[2]?.textContent).toContain("2 items");
    expect(container.textContent).not.toContain("60");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows the empty text when there are no amounts", () => {
    render(<MoneyByCurrency totals={[]} empty="Nothing open" />);
    expect(screen.getByText("Nothing open")).toBeTruthy();
  });
});

interface R {
  id: number;
  name: string;
  amount: number;
}
const ROWS: R[] = [
  { id: 1, name: "Alpha", amount: 100 },
  { id: 2, name: "Beta", amount: 200 },
  { id: 3, name: "Gamma", amount: 300 },
];
const COLS: Column<R>[] = [
  { key: "name", header: "Name", primary: true, render: (r) => r.name },
  { key: "due", header: "Due date", sortable: true, render: (r) => `due ${r.id}` },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    render: (r) => <Money minor={r.amount} currency="EUR" />,
  },
];

function Harness(props: Partial<React.ComponentProps<typeof DataTable<R>>>) {
  const [open, setOpen] = useState<R | null>(null);
  return (
    <>
      <input aria-label="Search" />
      <DataTable
        caption="Things"
        columns={COLS}
        rows={ROWS}
        rowKey={(r) => r.id}
        status="ready"
        onActivate={setOpen}
        activeKey={open?.id ?? null}
        {...props}
      />
      <p data-testid="open">{open?.name ?? "none"}</p>
    </>
  );
}

describe("DataTable", () => {
  it("is a semantic table with a caption, column headers and one row per item", async () => {
    const { container } = render(<Harness />);
    const table = screen.getByRole("table", { name: "Things" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(table.className).toContain("stacked");
    // Cell captions for the stacked phone layout.
    expect(container.querySelectorAll(".cell-label").length).toBe(9);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("makes sortable headers buttons with aria-sort and reports the click", async () => {
    const onSort = vi.fn();
    const user = userEvent.setup();
    render(<Harness sort={{ key: "due", dir: "asc" }} onSort={onSort} />);
    const th = screen.getByRole("columnheader", { name: /Due date/ });
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    await user.click(within(th).getByRole("button", { name: /Due date/ }));
    expect(onSort).toHaveBeenCalledWith("due");
    expect(screen.getByRole("columnheader", { name: "Name" }).getAttribute("aria-sort")).toBeNull();
  });

  it("shows descending order and none for an unsorted sortable column", () => {
    const { rerender } = render(
      <Harness sort={{ key: "due", dir: "desc" }} onSort={() => undefined} />,
    );
    expect(screen.getByRole("columnheader", { name: /Due date/ }).getAttribute("aria-sort")).toBe(
      "descending",
    );
    rerender(<Harness sort={{ key: "other", dir: "asc" }} onSort={() => undefined} />);
    expect(screen.getByRole("columnheader", { name: /Due date/ }).getAttribute("aria-sort")).toBe(
      "none",
    );
  });

  it("opens a row from its button with Enter and with Space, and by clicking the row", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const alpha = screen.getByRole("button", { name: "Alpha" });
    alpha.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("open").textContent).toBe("Alpha");
    screen.getByRole("button", { name: "Beta" }).focus();
    await user.keyboard(" ");
    expect(screen.getByTestId("open").textContent).toBe("Beta");
    await user.click(screen.getByText("due 3"));
    expect(screen.getByTestId("open").textContent).toBe("Gamma");
  });

  it("moves with J and K, opens with Enter, and ignores keys while typing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.keyboard("j");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alpha" }));
    await user.keyboard("j");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Beta" }));
    await user.keyboard("k");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alpha" }));
    // At the ends the selection stays.
    await user.keyboard("kk");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Alpha" }));
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("open").textContent).toBe("Alpha");

    const input = screen.getByLabelText("Search");
    await user.click(input);
    await user.keyboard("jjk");
    expect((input as HTMLInputElement).value).toBe("jjk");
    expect(document.activeElement).toBe(input);
  });

  it("does not capture J and K while a dialog is open", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness />
        <div role="dialog" aria-label="x" />
      </>,
    );
    await user.keyboard("j");
    expect(document.activeElement).toBe(document.body);
  });

  it("highlights the selected and the open row", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.keyboard("j");
    expect(container.querySelectorAll("tr.sel")).toHaveLength(1);
  });

  it("shows skeleton rows and a polite loading message while loading", () => {
    const { container } = render(<Harness status="loading" skeletonRows={4} />);
    expect(container.querySelectorAll(".sk-row")).toHaveLength(4);
    expect(screen.getByRole("status").textContent).toBe("Loading");
    expect(container.querySelector(".dt")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
  });

  it("shows the empty state instead of the table", () => {
    render(<Harness rows={[]} empty={<p>Nothing here</p>} />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows an error with a retry", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <Harness status="error" errorMessage="Could not load" onRetry={onRetry} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Could not load");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("renders footer rows inside tfoot", () => {
    render(
      <Harness
        footer={
          <tr>
            <th scope="row">Total</th>
            <td>1</td>
          </tr>
        }
      />,
    );
    expect(screen.getByRole("rowheader", { name: "Total" })).toBeTruthy();
  });
});

describe("LoadMore", () => {
  it("shows the counts, a button, and a failure message", async () => {
    const onMore = vi.fn();
    const user = userEvent.setup();
    render(<LoadMore shown={50} total={213} hasMore loading={false} failed onMore={onMore} />);
    expect(screen.getByText("Showing 50 of 213")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Could not load more.");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it("disables the button while loading and hides it on the last page", () => {
    const { rerender } = render(
      <LoadMore shown={50} hasMore loading failed={false} onMore={() => undefined} />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <LoadMore
        shown={50}
        hasMore={false}
        loading={false}
        failed={false}
        onMore={() => undefined}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("FilterBar", () => {
  it("reports search after typing pauses, one call for a burst", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterBar search={{ value: "", onChange, label: "Search things", debounceMs: 30 }} />);
    await user.type(screen.getByRole("searchbox", { name: "Search things" }), "acme");
    expect(onChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("acme"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("follows an outside reset of the value", () => {
    const { rerender } = render(
      <FilterBar search={{ value: "abc", onChange: () => undefined, label: "Search" }} />,
    );
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("abc");
    rerender(<FilterBar search={{ value: "", onChange: () => undefined, label: "Search" }} />);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });

  it("has a segmented status with pressed state, counts and a name", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <FilterBar
        status={{
          label: "Show",
          value: "a",
          options: [
            { value: "a", label: "A", count: 3 },
            { value: "b", label: "B" },
          ],
          onChange,
        }}
      />,
    );
    expect(screen.getByRole("button", { name: /^A/ }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("FreshnessStamp", () => {
  const admin = (admin: boolean) => ({
    "GET /api/auth/me": () => ({
      body: {
        email: "a@x.com",
        roles: admin ? ["admin"] : ["viewer"],
        stepUpFresh: true,
        allowedDomain: "x.com",
      },
    }),
  });
  void admin;

  const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it("shows Updated x ago for fresh data and nothing amber", () => {
    wrap(<FreshnessStamp freshness={FRESH} />);
    expect(screen.getByText(/Updated 5 min ago/)).toBeTruthy();
    expect(screen.queryByText("Out of date")).toBeNull();
  });

  it("flags stale data with a chip and one sentence", () => {
    wrap(<FreshnessStamp freshness={STALE} what="Open invoices" />);
    expect(screen.getByText("Out of date")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(
      /Open invoices was last read 2 days ago/,
    );
    expect(screen.getByRole("status").textContent).toMatch(/36 hours/);
  });

  it("says so when the data was never read", () => {
    wrap(<FreshnessStamp freshness={NEVER} what="Open invoices" />);
    expect(screen.getByText("Never synced")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("has not been read from Exact yet");
  });

  it("shows nothing without freshness (still loading)", () => {
    const { container } = wrap(<FreshnessStamp freshness={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("DrillSheet", () => {
  function Host({ view }: { view: string }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open it</button>
        <DrillSheet
          open={open}
          title="Detail"
          subtitle={<p>Summary</p>}
          onClose={() => setOpen(false)}
          viewKey={view}
        >
          <button data-autofocus>Back</button>
        </DrillSheet>
      </>
    );
  }

  it("moves focus into the dialog, closes with Escape and returns focus", async () => {
    const user = userEvent.setup();
    const { container } = render(<Host view="a" />);
    const opener = screen.getByRole("button", { name: "Open it" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Detail" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(await axe(container)).toHaveNoViolations();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes with its Close button", async () => {
    const user = userEvent.setup();
    render(<Host view="a" />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus to the autofocus element when the view changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Host view="a" />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    (document.activeElement as HTMLElement).blur();
    rerender(<Host view="b" />);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back" })),
    );
  });
});

describe("safeExactLink", () => {
  it("keeps https links on Exact Online hosts only", () => {
    expect(safeExactLink("https://start.exactonline.nl/docs/x?y=1")).toBe(
      "https://start.exactonline.nl/docs/x?y=1",
    );
    expect(safeExactLink("https://start.exactonline.co.uk/a")).toBe(
      "https://start.exactonline.co.uk/a",
    );
    for (const bad of [
      null,
      "",
      "javascript:alert(1)",
      "http://start.exactonline.nl/a",
      "https://start.exactonline.nl.evil.test/a",
      "https://evil-exactonline.nl/a",
      "https://user:pw@start.exactonline.nl/a",
      "//start.exactonline.nl/a",
      "not a url",
    ]) {
      expect(safeExactLink(bad), String(bad)).toBeNull();
    }
  });
});
