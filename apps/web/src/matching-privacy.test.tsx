/**
 * Review M7d: no full IBAN reaches the DOM (text, attributes, titles, aria), the address bar or
 * localStorage on any matching screen or sheet, even when the SERVER sends full IBANs in every text
 * field (a worker regression). The search text `q` never goes into the address either.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { AppShell } from "./App";
import { ADMIN, mockFetch, type Call } from "./test-utils";
import { accounts } from "./test-fixtures-bank";
import { listResponse, row } from "./test-fixtures";
import {
  accountMap,
  alloc,
  autoItem,
  booking,
  cand,
  config,
  detail,
  item,
  match,
  outbox,
  outboxItem,
  pattern,
  queue,
  stats,
  withItemBalances,
} from "./test-fixtures-matching";

const NL = "NL91ABNA0417164300";
const DE = "DE89 3704 0044 0532 0130 00";
/** Digit runs that must never appear (the masked forms keep only the last four). */
const SECRET = [/0417164300/, /ABNA0417/i, /0532\s?0130/, /3704\s?0044/];

const leak = (s: string): string[] =>
  SECRET.flatMap((re) => {
    const m = re.exec(s);
    return m ? [`${String(re)} near: ${s.slice(Math.max(0, m.index - 80), m.index + 20)}`] : [];
  });

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;

/** Every free-text field of every matching answer carries a full IBAN. */
function hostile(): H {
  const tx = {
    counterpartyName: `Acme ${NL}`,
    counterpartyIbanMasked: NL,
    reference: `Invoice INV-1 from ${DE}`,
    description: `Paid via ${NL}`,
    accountName: `Main ${DE}`,
    ignore: null,
  };
  const c = cand({
    explanation: [`The sender's account ${NL} belongs to Acme`],
    allocations: [alloc({ relationName: `Acme ${DE}`, invoiceNumber: `INV-${NL}` })],
  });
  const m = match({ note: `checked ${NL}`, undoReason: null });
  return withItemBalances({
    "GET /api/auth/me": () => ({ body: ADMIN }),
    "GET /api/bank/accounts": () => ({ body: accounts() }),
    "GET /api/matching/stats": () => ({ body: stats() }),
    "GET /api/matching/queue": (call) => {
      const status = new URL(call.url, "http://x").searchParams.get("status");
      if (status === "ignored") {
        return {
          body: queue([
            item({
              ...tx,
              matchStatus: "ignored",
              ignore: { reason: "other", note: `see ${NL}`, by: "f@x", at: "2026-11-01T10:00:00Z" },
            }),
          ]),
        };
      }
      return { body: queue([item(tx, [c])]) };
    },
    "GET /api/matching/auto": () => ({
      body: { items: [autoItem({ note: `auto ${NL}` }, tx)], nextCursor: null },
    }),
    "GET /api/matching/transactions/1": () => ({ body: detail(tx, [c], null) }),
    "GET /api/matching/transactions/2": () => ({ body: detail({ ...tx, id: 2 }, [c], m) }),
    "GET /api/invoices": () => ({
      body: listResponse([
        row({ id: 21, invoiceNumber: `INV-21`, relation: { id: 7, name: `Beta ${NL}` } }),
      ]),
    }),
    "GET /api/bills": () => ({ body: listResponse([]) }),
    "GET /api/booking/settings": () => ({
      body: booking({
        enabled: true,
        blockers: [NL],
        verified: { at: "2026-11-01T10:00:00Z", by: "a@x", note: `ok ${NL}`, protocolVersion: "1" },
      }),
    }),
    "GET /api/booking/outbox": () => ({
      body: outbox([
        outboxItem({
          counterpartyName: `Acme ${NL}`,
          itemLabels: [`INV ${DE}`],
          lastErrorCode: NL,
          exactRef: DE,
        }),
      ]),
    }),
    "GET /api/matching/config": () => ({ body: config() }),
    "GET /api/matching/account-map": () => ({
      body: accountMap({
        accounts: [
          {
            bankAccountId: 1,
            accountName: `Main ${NL}`,
            ibanMasked: NL,
            currency: "EUR",
            divisionId: null,
            divisionName: null,
            journalCode: null,
            bankGlAccountCode: null,
            updatedAt: null,
            updatedBy: null,
          },
        ],
      }),
    }),
    "GET /api/matching/patterns": () => ({
      body: { patterns: [pattern({ name: `Fees ${NL}`, counterpartyNameRegex: "^revolut" })] },
    }),
  });
}

function renderAt(path: string) {
  const loc = { href: "" };
  function Probe() {
    const l = useLocation();
    loc.href = `${l.pathname}${l.search}${l.hash}`;
    return null;
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
      <Probe />
    </MemoryRouter>,
  );
  return loc;
}

/** The whole document as HTML: text, every attribute (title, aria-*, href, value), plus storage. */
function everything(loc: { href: string }): string {
  const values = Array.from(document.querySelectorAll("input,textarea,select")).map(
    (e) => (e as HTMLInputElement).value,
  );
  return [
    document.documentElement.outerHTML,
    values.join("\n"),
    loc.href,
    window.location.href,
    JSON.stringify({ ...localStorage }),
    JSON.stringify({ ...sessionStorage }),
  ].join("\n");
}

async function settle(name: string) {
  const t = await screen.findByRole("table", { name });
  await waitFor(() => expect(t.querySelector(".sk-row")).toBeNull());
  return t;
}

describe("no full IBAN anywhere, even when the server sends them", () => {
  it("review queue, match sheet with candidates, explanations, picker and editor", async () => {
    const user = userEvent.setup();
    mockFetch(hostile());
    const loc = renderAt("/treasury/bank?tab=review");
    const t = await settle("Bank lines to review");
    expect(leak(everything(loc))).toEqual([]);
    await user.click(within(t).getAllByRole("button")[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Match bank line" });
    await within(dialog).findByText("Counterparty");
    expect(leak(everything(loc))).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Match to another invoice…" }));
    await within(dialog).findByText("INV-21");
    await user.click(within(dialog).getByRole("button", { name: "Add INV-21" }));
    await user.click(within(dialog).getAllByRole("radio")[0] as HTMLElement);
    expect(leak(everything(loc))).toEqual([]);
  });

  it("the search text stays out of the address bar", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(hostile());
    const loc = renderAt("/treasury/bank?tab=review");
    await settle("Bank lines to review");
    await user.type(screen.getByLabelText("Search lines to review"), "acme");
    await waitFor(() =>
      expect(calls.some((c) => new URL(c.url, "http://x").searchParams.get("q") === "acme")).toBe(
        true,
      ),
    );
    expect(loc.href).not.toContain("acme");
    expect(loc.href).not.toContain("q=");
  });

  it("automatic matches, the undo sheet and the ignored list", async () => {
    const user = userEvent.setup();
    mockFetch(hostile());
    const loc = renderAt("/treasury/bank?tab=auto");
    await settle("Matched automatically");
    expect(leak(everything(loc))).toEqual([]);
    await user.click(screen.getByRole("button", { name: /Undo the match of/ }));
    await screen.findByRole("dialog", { name: "Undo automatic match" });
    expect(leak(everything(loc))).toEqual([]);
  });

  it("the ignored list", async () => {
    mockFetch(hostile());
    const loc = renderAt("/treasury/bank?tab=ignored");
    await settle("Ignored bank lines");
    await screen.findByText(/Other reason/);
    expect(leak(everything(loc))).toEqual([]);
  });

  it("Settings, Matching: account map, patterns, booking card, outbox and its sheets", async () => {
    const user = userEvent.setup();
    mockFetch(hostile());
    const loc = renderAt("/settings/matching");
    await screen.findByRole("heading", { level: 2, name: "Booking in Exact" });
    await settle("Booking queue");
    await screen.findByText(/Fees/);
    expect(leak(everything(loc))).toEqual([]);
    await user.click(screen.getAllByRole("button", { name: /^Retry: / })[0] as HTMLElement);
    await screen.findByRole("dialog", { name: "Retry booking in Exact" });
    expect(leak(everything(loc))).toEqual([]);
  });
});
