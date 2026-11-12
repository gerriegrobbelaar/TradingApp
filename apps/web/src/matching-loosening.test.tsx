/**
 * Review U2, web side: while automatic matching is on, a threshold or pattern save that lets it do
 * more asks for the typed phrase again (the server refuses it with 422 confirmation_required
 * otherwise); config saves carry the revision they were built from (409 conflict); the switch for
 * unknown incoming accounts is labelled as loosening; the floors are named in the hints.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { AUTO_MATCH_CONFIRM_PHRASE, MIN_AUTO_GAP, MIN_RECENT_IBAN_DAYS } from "@camelthorn/core";
import { ADMIN, mockFetch, renderApp, type Call } from "./test-utils";
import {
  TUNABLES,
  accountMap,
  booking,
  config,
  outbox,
  pattern,
  stats,
} from "./test-fixtures-matching";
import { tunablesLoosen } from "./lib/matching-settings";
import { patternLoosens } from "./components/matching/PatternsCard";

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });
const of = (calls: Call[], path: string, method = "GET") =>
  calls.filter((c) => c.method === method && c.url.split("?")[0] === path);
type H = Record<string, (c: Call) => { status?: number; body?: unknown }>;

async function open(over: H = {}) {
  const calls = mockFetch({
    "GET /api/auth/me": () => ({ body: ADMIN }),
    "GET /api/matching/stats": () => ({ body: stats() }),
    "GET /api/matching/config": () => ({ body: config({ autoEnabled: true }) }),
    "GET /api/matching/account-map": () => ({ body: accountMap() }),
    "GET /api/matching/patterns": () => ({ body: { patterns: [pattern()] } }),
    "GET /api/booking/settings": () => ({ body: booking() }),
    "GET /api/booking/outbox": () => ({ body: outbox() }),
    ...over,
  });
  const view = renderApp("/settings/matching");
  await screen.findByLabelText(/Gap to the next candidate/);
  const c = screen
    .getByRole("heading", { level: 2, name: "Matching thresholds" })
    .closest(".card") as HTMLElement;
  return { calls, view, c };
}

describe("thresholds: loosening while automatic matching is on", () => {
  it("names the floors from core in the hints", async () => {
    const { c } = await open();
    expect(c.textContent).toContain(`never below ${MIN_AUTO_GAP}`);
    expect(c.textContent).toContain(`never below ${MIN_RECENT_IBAN_DAYS}`);
    expect(MIN_AUTO_GAP).toBe(10);
    expect(MIN_RECENT_IBAN_DAYS).toBe(30);
  });

  it("a looser gap asks for the phrase, then sends config, confirm and rev", async () => {
    const user = userEvent.setup();
    const { calls, c } = await open({
      "PUT /api/matching/config": () => ({ body: config({ autoEnabled: true }) }),
    });
    const gap = within(c).getByLabelText(/Gap to the next candidate/);
    await user.clear(gap);
    await user.type(gap, "15");
    expect(within(c).getByText(/this change lets it do more/)).toBeTruthy();
    await user.click(within(c).getByRole("button", { name: "Save thresholds" }));
    expect(of(calls, "/api/matching/config", "PUT")).toHaveLength(0);
    const dialog = await screen.findByRole("dialog", { name: "Confirm looser automatic matching" });
    const go = within(dialog).getByRole("button", { name: "Save thresholds" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/to confirm/), AUTO_MATCH_CONFIRM_PHRASE);
    await user.click(go);
    await waitFor(() => expect(of(calls, "/api/matching/config", "PUT")).toHaveLength(1));
    expect(of(calls, "/api/matching/config", "PUT")[0]?.body).toEqual({
      config: { ...TUNABLES, autoMatchMinGap: 15 },
      confirm: AUTO_MATCH_CONFIRM_PHRASE,
      rev: "rev-1",
    });
    expect(await within(c).findByText("Matching thresholds")).toBeTruthy();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("a tighter change saves at once (with rev), and with automatic matching off nothing asks", async () => {
    const user = userEvent.setup();
    const a = await open({
      "PUT /api/matching/config": () => ({ body: config({ autoEnabled: true }) }),
    });
    const gap = within(a.c).getByLabelText(/Gap to the next candidate/);
    await user.clear(gap);
    await user.type(gap, "30");
    await user.click(within(a.c).getByRole("button", { name: "Save thresholds" }));
    await waitFor(() => expect(of(a.calls, "/api/matching/config", "PUT")).toHaveLength(1));
    expect(of(a.calls, "/api/matching/config", "PUT")[0]?.body).toEqual({
      config: { ...TUNABLES, autoMatchMinGap: 30 },
      rev: "rev-1",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    a.view.unmount();
    const b = await open({
      "GET /api/matching/config": () => ({ body: config() }),
      "PUT /api/matching/config": () => ({ body: config() }),
    });
    const gap2 = within(b.c).getByLabelText(/Gap to the next candidate/);
    await user.clear(gap2);
    await user.type(gap2, "10");
    await user.click(within(b.c).getByRole("button", { name: "Save thresholds" }));
    await waitFor(() => expect(of(b.calls, "/api/matching/config", "PUT")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for the phrase when the server says so, even if this screen did not expect it", async () => {
    const user = userEvent.setup();
    let n = 0;
    const { calls, c } = await open({
      "GET /api/matching/config": () => ({ body: config() }),
      "PUT /api/matching/config": () =>
        ++n === 1 ? { status: 422, body: { error: "confirmation_required" } } : { body: config() },
    });
    const gap = within(c).getByLabelText(/Gap to the next candidate/);
    await user.clear(gap);
    await user.type(gap, "30");
    await user.click(within(c).getByRole("button", { name: "Save thresholds" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm looser automatic matching" });
    await user.type(within(dialog).getByLabelText(/to confirm/), AUTO_MATCH_CONFIRM_PHRASE);
    await user.click(within(dialog).getByRole("button", { name: "Save thresholds" }));
    await waitFor(() => expect(of(calls, "/api/matching/config", "PUT")).toHaveLength(2));
    expect(of(calls, "/api/matching/config", "PUT")[1]?.body).toMatchObject({
      confirm: AUTO_MATCH_CONFIRM_PHRASE,
    });
  });

  it("a stale revision is explained and nothing is overwritten", async () => {
    const user = userEvent.setup();
    const { c } = await open({
      "GET /api/matching/config": () => ({ body: config() }),
      "PUT /api/matching/config": () => ({ status: 409, body: { error: "conflict" } }),
    });
    const gap = within(c).getByLabelText(/Gap to the next candidate/);
    await user.clear(gap);
    await user.type(gap, "30");
    await user.click(within(c).getByRole("button", { name: "Save thresholds" }));
    expect(await within(c).findByText(/Somebody else changed these settings/)).toBeTruthy();
  });

  it("the unknown-incoming-account switch is labelled as loosening and asks for the phrase", async () => {
    const user = userEvent.setup();
    const { calls, c } = await open({
      "PUT /api/matching/config": () => ({ body: config({ autoEnabled: true }) }),
    });
    const box = within(c).getByRole("checkbox", {
      name: /unknown account.*loosens automatic matching/,
    });
    expect((box as HTMLInputElement).checked).toBe(false);
    await user.click(box);
    await user.click(within(c).getByRole("button", { name: "Save thresholds" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm looser automatic matching" });
    await user.type(within(dialog).getByLabelText(/to confirm/), AUTO_MATCH_CONFIRM_PHRASE);
    await user.click(within(dialog).getByRole("button", { name: "Save thresholds" }));
    await waitFor(() => expect(of(calls, "/api/matching/config", "PUT")).toHaveLength(1));
    expect(of(calls, "/api/matching/config", "PUT")[0]?.body).toMatchObject({
      config: { autoIncomingUnknownIban: true },
    });
  });

  it("tunablesLoosen follows core's rule", () => {
    expect(tunablesLoosen(TUNABLES, { ...TUNABLES, autoMatchMinGap: 15 })).toBe(true);
    expect(tunablesLoosen(TUNABLES, { ...TUNABLES, autoMatchMinGap: 25 })).toBe(false);
    expect(tunablesLoosen(TUNABLES, { ...TUNABLES, autoIncomingUnknownIban: true })).toBe(true);
    expect(tunablesLoosen(TUNABLES, { ...TUNABLES, maxCandidates: 50 })).toBe(false);
    expect(
      tunablesLoosen(TUNABLES, { ...TUNABLES, autoTxTypes: [...TUNABLES.autoTxTypes, "fee"] }),
    ).toBe(true);
  });
});

describe("ledger patterns while automatic ledger patterns are on", () => {
  const AUTO_LEDGER = () =>
    config({ autoEnabled: true, config: { ...TUNABLES, autoLedgerPatterns: true } });
  const patternsCard = () =>
    screen
      .getByRole("heading", { level: 2, name: "Ledger patterns" })
      .closest(".card") as HTMLElement;

  it("a new pattern needs the phrase and sends it", async () => {
    const user = userEvent.setup();
    const { calls } = await open({
      "GET /api/matching/config": () => ({ body: AUTO_LEDGER() }),
      "POST /api/matching/patterns": () => ({ status: 201, body: { pattern: pattern({ id: 2 }) } }),
    });
    await user.click(await within(patternsCard()).findByRole("button", { name: "Add pattern…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add ledger pattern" });
    await user.type(within(dialog).getByLabelText(/^Name/), "Card fees");
    await user.type(within(dialog).getByLabelText(/Ledger account code/), "4510");
    await user.type(within(dialog).getByLabelText(/Counterparty name pattern/), "^stripe");
    const add = within(dialog).getByRole("button", { name: "Add pattern" }) as HTMLButtonElement;
    expect(dialog.textContent).toContain("can book lines to a ledger account without a person");
    expect(add.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/to confirm/), AUTO_MATCH_CONFIRM_PHRASE);
    expect(add.disabled).toBe(false);
    await user.click(add);
    await waitFor(() => expect(of(calls, "/api/matching/patterns", "POST")).toHaveLength(1));
    expect(of(calls, "/api/matching/patterns", "POST")[0]?.body).toMatchObject({
      name: "Card fees",
      confirm: AUTO_MATCH_CONFIRM_PHRASE,
    });
  });

  it("without automatic ledger patterns nothing asks; a server 422 shows the field", async () => {
    const user = userEvent.setup();
    let n = 0;
    const { calls } = await open({
      "GET /api/matching/config": () => ({ body: config() }),
      "POST /api/matching/patterns": () =>
        ++n === 1
          ? { status: 422, body: { error: "confirmation_required" } }
          : { status: 201, body: { pattern: pattern({ id: 2 }) } },
    });
    await user.click(await within(patternsCard()).findByRole("button", { name: "Add pattern…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add ledger pattern" });
    await user.type(within(dialog).getByLabelText(/^Name/), "Card fees");
    await user.type(within(dialog).getByLabelText(/Ledger account code/), "4510");
    await user.type(within(dialog).getByLabelText(/Counterparty name pattern/), "^stripe");
    expect(within(dialog).queryByLabelText(/to confirm/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Add pattern" }));
    const field = await within(dialog).findByLabelText(/to confirm/);
    await user.type(field, AUTO_MATCH_CONFIRM_PHRASE);
    await user.click(within(dialog).getByRole("button", { name: "Add pattern" }));
    await waitFor(() => expect(of(calls, "/api/matching/patterns", "POST")).toHaveLength(2));
    expect(of(calls, "/api/matching/patterns", "POST")[1]?.body).toMatchObject({
      confirm: AUTO_MATCH_CONFIRM_PHRASE,
    });
  });

  it("patternLoosens: renaming or disabling never needs it; a new match field does", () => {
    const p = pattern();
    const req = {
      name: p.name,
      ledgerAccountCode: p.ledgerAccountCode,
      counterpartyNameRegex: p.counterpartyNameRegex,
      referenceRegex: p.referenceRegex,
      type: p.type,
      direction: p.direction,
      maxAmountMinor: p.maxAmountMinor,
      enabled: true,
    };
    expect(patternLoosens(true, p, { ...req, name: "Renamed" })).toBe(false);
    expect(patternLoosens(true, p, { ...req, enabled: false })).toBe(false);
    expect(patternLoosens(true, p, { ...req, maxAmountMinor: 9999 })).toBe(true);
    expect(patternLoosens(true, { ...p, enabled: false }, req)).toBe(true);
    expect(patternLoosens(true, null, req)).toBe(true);
    expect(patternLoosens(false, null, req)).toBe(false);
  });
});
