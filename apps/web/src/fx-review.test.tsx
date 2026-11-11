/**
 * Review F3: what the builder's tests did not pin down. Layout while the rates load, a missing
 * rate on the Overview, the administration switch, the item sheet's base currency, the import
 * code on the FX tab, and Import now's re-read timers and double clicks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { KpiAmountDto } from "@camelthorn/core";
import { DivisionProvider, useDivision } from "./division";
import { FxProvider, useFxRates } from "./fx";
import { lastImportText } from "./pages/FxRates";
import { ToastProvider } from "./toasts";
import { ADMIN, VIEWER, mockFetch, renderApp } from "./test-utils";
import {
  DIV_REF,
  ONE_DIVISION,
  TWO_DIVISIONS,
  detail,
  kpis,
  listResponse,
  overview,
  row,
} from "./test-fixtures";
import { GBP_DIVISION, fxRates, fxRatesNoGbp, importJob, jobsResponse } from "./test-fixtures-fx";
import { norm } from "./test-norm";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const me = (m = VIEWER) => ({ "GET /api/auth/me": () => ({ body: m }) });
const divs = (body = ONE_DIVISION) => ({ "GET /api/divisions": () => ({ body }) });
const amt = (minor: number, dc: number, complete = true, count = 1): KpiAmountDto => ({
  count,
  minor,
  dcMinor: dc,
  dcComplete: complete,
});
const usdKpis = (path: "/api/invoices" | "/api/bills") =>
  kpis(path, "USD", {
    total: amt(10_000, 9_000),
    overdue: amt(0, 0, true, 0),
    due7: amt(0, 0, true, 0),
    due30: amt(0, 0, true, 0),
  });

/** Holds back every request whose path starts with `prefix` until `release()` is called. */
function holdBack(prefix: string) {
  const real = globalThis.fetch;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    if (String(args[0]).startsWith(prefix)) await gate;
    return (real as typeof fetch)(...args);
  });
  return () => release();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("no layout jump while the rates load", () => {
  it("keeps the space of the FX lines on the Overview, then puts the lines in their place", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...{ "GET /api/fx/rates": () => ({ body: fxRates() }) },
      "GET /api/overview": () => ({
        body: overview({
          kpis: { receivable: [kpis("/api/invoices"), usdKpis("/api/invoices")], payable: [] },
        }),
      }),
    });
    const release = holdBack("/api/fx/rates");
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await waitFor(() => expect(recv.querySelector("[data-fx-pending]")).not.toBeNull());
    // the USD total figure reserves: today's value, booked and difference, and the sentence
    const figureLines = () =>
      Array.from(recv.querySelectorAll(".fx-amount")).map((el) => el.children.length);
    expect(figureLines()).toEqual([3]);
    // nothing converted to a guessed currency, and Exact's line does not flash in and out
    expect(norm(recv.textContent)).not.toContain("booked in Exact");
    expect(norm(recv.textContent)).not.toContain("about €");
    // the headline block holds its place too
    expect(recv.querySelector(".fx-headline[data-fx-pending]")).not.toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(recv.querySelector("[data-fx-pending]")).toBeNull());
    expect(figureLines()).toEqual([3]);
    expect(norm(recv.textContent)).toContain("Booked € 90,00 · estimated difference +€ 2,14");
  });

  it("keeps a row's height in the invoices table while the rates load", async () => {
    const usd = row({ id: 1, invoiceNumber: "INV-USD", currency: "USD", openMinor: 10_000 });
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/fx/rates": () => ({ body: fxRates() }),
      "GET /api/invoices": () => ({ body: listResponse([usd]) }),
    });
    const release = holdBack("/api/fx/rates");
    renderApp("/invoices");
    const table = await screen.findByRole("table", { name: "Invoices" });
    await waitFor(() => expect(table.querySelector(".fx-row[data-fx-pending]")).not.toBeNull());
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(norm(table.textContent)).toContain("about € 92,14"));
    expect(table.querySelector("[data-fx-pending]")).toBeNull();
  });

  it("does not convert to the EUR fall-back while the administrations are still loading", async () => {
    mockFetch({
      ...me(),
      "GET /api/divisions": () => ({ body: GBP_DIVISION }),
      "GET /api/fx/rates": () => ({ body: fxRates() }),
    });
    const release = holdBack("/api/divisions");
    function Probe() {
      const fx = useFxRates();
      return (
        <p data-testid="p">
          {String(fx.ready)}:{String(fx.pending)}:{fx.base}
        </p>
      );
    }
    render(
      <ToastProvider>
        <DivisionProvider>
          <FxProvider>
            <Probe />
          </FxProvider>
        </DivisionProvider>
      </ToastProvider>,
    );
    // rates are in, the administration is not: not ready, still pending
    await waitFor(() => expect(screen.getByTestId("p").textContent).toBe("false:true:EUR"));
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("p").textContent).toBe("true:false:GBP"));
  });
});

describe("switching administration", () => {
  it("changes the base currency at once, and the Overview never mixes the old figures with the new base", async () => {
    const two = {
      ...TWO_DIVISIONS,
      divisions: TWO_DIVISIONS.divisions.map((d) => (d.id === 2 ? { ...d, currency: "GBP" } : d)),
    };
    mockFetch({
      ...me(),
      "GET /api/divisions": () => ({ body: two }),
      "PUT /api/me/division": () => ({ body: {} }),
      "POST /api/me/division": () => ({ body: {} }),
      "GET /api/fx/rates": () => ({ body: fxRates() }),
    });
    function Probe() {
      const fx = useFxRates();
      const d = useDivision();
      return (
        <>
          <p data-testid="p">
            {fx.base}:{String(fx.baseAssumed)}
          </p>
          <button type="button" onClick={() => void d.select(2)}>
            switch
          </button>
        </>
      );
    }
    render(
      <ToastProvider>
        <DivisionProvider>
          <FxProvider>
            <Probe />
          </FxProvider>
        </DivisionProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("p").textContent).toBe("EUR:false"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "switch" }));
    // immediately, before any page data has been re-read
    expect(screen.getByTestId("p").textContent).toBe("GBP:false");
  });

  it("an Overview still showing the previous administration's figures falls back to Exact's line", async () => {
    // The selected administration is GBP, the Overview answer is still the EUR one.
    mockFetch({
      ...me(),
      ...divs(GBP_DIVISION),
      "GET /api/fx/rates": () => ({ body: fxRates() }),
      "GET /api/overview": () => ({
        body: overview({
          division: { ...DIV_REF, currency: "EUR" },
          kpis: { receivable: [kpis("/api/invoices"), usdKpis("/api/invoices")], payable: [] },
        }),
      }),
    });
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await waitFor(() => expect(norm(recv.textContent)).toContain("€ 90,00 booked in Exact"));
    expect(norm(recv.textContent)).not.toContain("today's ECB rate");
    expect(norm(recv.textContent)).not.toMatch(/£/);
  });

  it("the item sheet converts into the item's own administration currency, as its label says", async () => {
    // GBP administration selected, but the item (and its booked amount) is in EUR.
    const usd = row({
      id: 1,
      invoiceNumber: "INV-USD",
      currency: "USD",
      openMinor: 10_000,
      dcMinor: 9_000,
      dcCurrency: "EUR",
    });
    mockFetch({
      ...me(),
      ...divs(GBP_DIVISION),
      "GET /api/fx/rates": () => ({ body: fxRates() }),
      "GET /api/invoices": () => ({ body: listResponse([usd]) }),
      "GET /api/open-items/1": () => ({ body: detail(usd) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    const table = await screen.findByRole("table", { name: "Invoices" });
    await user.click(await within(table).findByRole("button", { name: "INV-USD" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/Open balance in EUR at today's ECB rate/);
    await waitFor(() =>
      expect(norm(dialog.textContent)).toContain(
        "Booked € 90,00 · difference +€ 2,14 at today's ECB rate",
      ),
    );
    // never booked euros against today's pounds
    expect(norm(dialog.textContent)).not.toMatch(/Booked £|difference [+-]?£/);
  });
});

describe("Overview with a foreign currency whose rate is missing", () => {
  it("still shows the original amounts, says which rate is missing, and never NaN or undefined", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/fx/rates": () => ({ body: fxRatesNoGbp() }),
      "GET /api/overview": () => ({
        body: overview({
          kpis: {
            receivable: [
              kpis("/api/invoices"),
              kpis("/api/invoices", "GBP", {
                total: amt(5_000, 5_800),
                overdue: amt(2_000, 2_300),
              }),
            ],
            payable: [kpis("/api/bills", "GBP", { total: amt(7_000, 0, false, 2) })],
          },
        }),
      }),
    });
    const { container } = renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    await waitFor(() => expect(norm(recv.textContent)).toContain("No ECB rate for GBP"));
    const all = norm(document.body.textContent);
    expect(all).toContain("£ 50,00");
    expect(all).toContain("£ 20,00");
    expect(all).toContain("£ 70,00");
    expect(all).not.toMatch(/NaN|undefined|null|Infinity/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("in a GBP administration without a GBP rate, the note names GBP, not the other currencies", async () => {
    mockFetch({
      ...me(),
      ...divs(GBP_DIVISION),
      "GET /api/fx/rates": () => ({ body: fxRatesNoGbp() }),
      "GET /api/overview": () => ({
        body: overview({
          division: { ...DIV_REF, currency: "GBP" },
          kpis: {
            receivable: [
              kpis("/api/invoices", "GBP", { total: amt(5_000, 5_000) }),
              usdKpis("/api/invoices"),
            ],
            payable: [],
          },
        }),
      }),
    });
    renderApp("/overview");
    const recv = await screen.findByRole("region", { name: "Receivables" });
    const head = await within(recv).findByRole("region", {
      name: "Total in GBP at today's ECB rates, receivables",
    });
    expect(norm(head.textContent)).toContain("Not included: USD (no ECB rate for GBP)");
    expect(norm(recv.textContent)).toContain("No ECB rate for GBP");
    expect(norm(recv.textContent)).not.toMatch(/NaN|undefined/);
  });
});

describe("Settings, FX rates: the import code", () => {
  const base = fxRates({ lastImportStatus: "error", lastImportCode: "rate_not_published" });

  it("words the known codes and still shows the code", () => {
    expect(lastImportText(base)).toMatch(
      /— failed \(rate_not_published\): the ECB had not published today's rates by 17:30$/,
    );
    const words: Record<string, RegExp> = {
      ecb_rate_limited: /failed \(ecb_rate_limited\): the ECB asked us to slow down/,
      bad_response: /failed \(bad_response\): the ECB sent data that could not be read/,
      too_late: /failed \(too_late\): the run started after 17:30/,
      ecb_network: /failed \(ecb_network\): the ECB could not be reached/,
      network: /failed \(network\): the ECB could not be reached/,
    };
    for (const [code, re] of Object.entries(words)) {
      expect(lastImportText({ ...base, lastImportCode: code })).toMatch(re);
    }
    expect(
      lastImportText({ ...base, lastImportStatus: "partial", lastImportCode: "not_yet_published" }),
    ).toMatch(/partly done, retrying \(not_yet_published\): today's rates are not published yet/);
  });

  it("an unknown code is shown as the code; an odd value or an ok run shows none", () => {
    expect(lastImportText({ ...base, lastImportCode: "something_new" })).toMatch(
      /— failed \(something_new\)$/,
    );
    expect(lastImportText({ ...base, lastImportCode: "<b>x</b>" })).toMatch(/— failed$/);
    expect(
      lastImportText({ ...base, lastImportStatus: "ok", lastImportCode: "already_current" }),
    ).toMatch(/— OK$/);
    expect(
      lastImportText({ ...base, lastImportStatus: "skipped", lastImportCode: "non_working_day" }),
    ).toMatch(/— skipped \(not a working day\)$/);
    expect(lastImportText({ ...base, lastImportCode: undefined })).toMatch(/— failed$/);
  });

  it("is on the tab", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      "GET /api/fx/rates": () => ({ body: base }),
      "GET /api/fx/history": () => ({ body: { currency: "USD", base: "EUR", points: [] } }),
    });
    renderApp("/settings/fx");
    expect(
      await screen.findByText(/failed \(rate_not_published\): the ECB had not published/),
    ).toBeTruthy();
  });
});

describe("Import now: re-reads, clean-up and no double start", () => {
  const FIN = { ...ADMIN, roles: ["finance" as const] };

  function setup(post: () => { status?: number; body?: unknown }) {
    return mockFetch({
      ...me(FIN),
      ...divs(),
      "GET /api/fx/rates": () => ({ body: fxRates() }),
      "GET /api/fx/history": () => ({ body: { currency: "USD", base: "EUR", points: [] } }),
      "GET /api/jobs": () => ({ body: jobsResponse([importJob()]) }),
      "POST /api/jobs/9/run": post,
    });
  }
  const ratesReads = (calls: { method: string; url: string }[]) =>
    calls.filter((c) => c.method === "GET" && c.url === "/api/fx/rates").length;

  it("re-reads the rates after 4, 12 and 30 seconds, and stops when the tab is left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = setup(() => ({ body: { runId: 1, status: "queued" } }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = renderApp("/settings/fx");
    await user.click(await screen.findByRole("button", { name: "Import now" }));
    await screen.findByText("Started the ECB import. The rates update here when it finishes.");
    const before = ratesReads(calls);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await waitFor(() => expect(ratesReads(calls)).toBe(before + 1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    await waitFor(() => expect(ratesReads(calls)).toBe(before + 2));
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // the 30 s re-read was cancelled with the page
    expect(ratesReads(calls)).toBe(before + 2);
  });

  it("starts one run for a double click", async () => {
    let posts = 0;
    setup(() => {
      posts += 1;
      return { body: { runId: 1, status: "queued" } };
    });
    renderApp("/settings/fx");
    const button = await screen.findByRole("button", { name: "Import now" });
    await act(async () => {
      button.click();
      button.click();
      button.click();
    });
    await screen.findByText("Started the ECB import. The rates update here when it finishes.");
    expect(posts).toBe(1);
    // and the cooldown keeps it off afterwards
    expect((screen.getByRole("button", { name: /Import now/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("watches for the result when the import is already running (409)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = setup(() => ({ status: 409, body: { error: "already_running" } }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp("/settings/fx");
    await user.click(await screen.findByRole("button", { name: "Import now" }));
    await screen.findByText(/The ECB import is already running/);
    const before = ratesReads(calls);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await waitFor(() => expect(ratesReads(calls)).toBe(before + 1));
  });
});
