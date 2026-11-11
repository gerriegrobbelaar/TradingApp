/**
 * Review of T2: the implied booked rate checked by hand, the stale and hidden states on the Bank
 * page and the ageing totals, and the ageing Excel row equal to the screen cells digit for digit.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AGEING_BUCKETS, unrealisedDifference } from "@camelthorn/core";
import { strFromU8, unzipSync } from "fflate";
import { VIEWER, mockFetch, renderApp } from "./test-utils";
import { ONE_DIVISION, detail, listResponse, row } from "./test-fixtures";
import { ageingResponse, type AgeingFixtureItem } from "./test-fixtures-reports";
import { account, accounts, tx, txDetail, txs } from "./test-fixtures-bank";
import { fxOutage, fxRates, fxStale } from "./test-fixtures-fx";
import { ageingExport } from "./export/report-workbooks";
import { buildXlsx, type SheetSpec } from "./export/xlsx";
import {
  ageingTotalsInBase,
  impliedBookedRate,
  rateTableFromResponse,
  totalsWording,
} from "./lib/fx";
import { formatRate } from "./lib/format";
import { norm } from "./test-norm";

const me = () => ({ "GET /api/auth/me": () => ({ body: VIEWER }) });
const divs = () => ({ "GET /api/divisions": () => ({ body: ONE_DIVISION }) });
const rates = (body: unknown) => ({ "GET /api/fx/rates": () => ({ body }) });
const HIDDEN = "ECB rates are 7 working days old; estimates are hidden";

describe("implied booked rate: base currency per 1 unit of the item currency (hand checked)", () => {
  // Each expectation is worked out by hand from the definition booked / open in major units.
  it.each([
    // 90,00 EUR / 100,00 USD = 0,9 EUR per USD
    ["USD 100,00 booked at € 90,00", 10_000, "USD", 9_000, "EUR", "0.9"],
    // 60,42 EUR / 10.000 JPY = 0,006042 EUR per JPY (JPY has no minor unit)
    ["JPY 10.000 booked at € 60,42", 10_000, "JPY", 6_042, "EUR", "0.006042"],
    // 3.000,00 EUR / 1,000 KWD = 3000 EUR per KWD (KWD has three decimals)
    ["KWD 1,000 booked at € 3.000,00", 1_000, "KWD", 300_000, "EUR", "3000"],
    // 100,00 EUR / 300,00 USD = 0,3333333333333... -> 12 dp, half away from zero
    ["a third", 30_000, "USD", 10_000, "EUR", "0.333333333333"],
    // 2,00 EUR / 3,00 USD = 0,6666666666666... -> rounds up in the 12th place
    ["two thirds", 300, "USD", 200, "EUR", "0.666666666667"],
    // a credit note: both negative, same rate
    ["a credit note", -10_000, "USD", -9_000, "EUR", "0.9"],
    // a GBP administration: 80,35 GBP / 100,00 USD
    ["USD in a GBP administration", 10_000, "USD", 8_035, "GBP", "0.8035"],
  ])("%s", (_n, open, currency, booked, base, expected) => {
    expect(
      impliedBookedRate({
        openMinor: open as number,
        currency: currency as string,
        bookedMinor: booked as number,
        base: base as string,
      }),
    ).toBe(expected);
  });

  it("is not given for 0, opposite signs, unknown or unsafe amounts", () => {
    const at = (o: number, b: number | null) =>
      impliedBookedRate({ openMinor: o, currency: "USD", bookedMinor: b, base: "EUR" });
    expect(at(0, 100)).toBeNull();
    expect(at(100, 0)).toBeNull();
    expect(at(100, -90)).toBeNull();
    expect(at(100, null)).toBeNull();
    expect(at(1.5, 100)).toBeNull();
    expect(at(2 ** 60, 100)).toBeNull();
  });

  it("agrees with core's unrealisedDifference for many amounts", () => {
    const table = rateTableFromResponse(fxRates()) as NonNullable<
      ReturnType<typeof rateTableFromResponse>
    >;
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 500; i++) {
      const open = (next() % 10_000_000) + 1;
      const booked = (next() % 10_000_000) + 1;
      for (const currency of ["USD", "JPY", "KWD"]) {
        const core = unrealisedDifference({
          openMinor: open,
          currency,
          bookedBaseMinor: booked,
          baseCurrency: "EUR",
          table,
        });
        expect(core.ok).toBe(true);
        if (!core.ok) continue;
        expect(
          impliedBookedRate({ openMinor: open, currency, bookedMinor: booked, base: "EUR" }),
        ).toBe(core.impliedBookedRate);
      }
    }
  });

  it("the item sheet writes it with the direction, beside the ECB rate in the ECB's direction", async () => {
    const jpy = row({
      id: 7,
      invoiceNumber: "INV-JPY",
      currency: "JPY",
      openMinor: 10_000,
      dcMinor: 6_042,
    });
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxRates()),
      "GET /api/invoices": () => ({ body: listResponse([jpy]) }),
      "GET /api/open-items/7": () => ({ body: detail(jpy, { rate: "165.4" }) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-JPY" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Implied booked rate");
    const text = norm(dialog.textContent);
    expect(text).toContain("1 JPY = € 0,006042 (booked amount divided by open amount)");
    expect(text).toContain("1 EUR = 165,5000 JPY (10 Nov)");
    // Exact's raw rate is a bare number: no direction is claimed for it
    expect(text).toContain("165,40 (as stored in Exact; direction unverified)");
    expect(text).not.toMatch(/1 JPY = € 165/);
    expect(formatRate("0.006042")).toBe("0,006042");
  });

  it("the implied rate stays when the ECB rates are too old (it needs no ECB rate)", async () => {
    const usd = row({
      id: 1,
      invoiceNumber: "INV-USD",
      currency: "USD",
      openMinor: 10_000,
      dcMinor: 9_000,
    });
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxOutage()),
      "GET /api/invoices": () => ({ body: listResponse([usd]) }),
      "GET /api/open-items/1": () => ({ body: detail(usd) }),
    });
    const user = userEvent.setup();
    renderApp("/invoices");
    await user.click(await screen.findByRole("button", { name: "INV-USD" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("No estimate: the ECB rates are 7 working days old");
    expect(norm(dialog.textContent)).toContain("1 USD = € 0,9000");
    expect(within(dialog).queryByText(/^ECB/)).toBeNull();
  });
});

describe("Bank page with old rates", () => {
  const gbp = () =>
    accounts([
      account(),
      account({ id: 2, name: "Sterling", currency: "GBP", balanceMinor: 50_025 }),
    ]);

  it("hides every estimate past the cut-off: total, rows and the transaction sheet", async () => {
    const t = tx({ id: 10, currency: "USD", amountMinor: -12_345, counterpartyName: "Cloud Inc" });
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxOutage()),
      "GET /api/bank/accounts": () => ({ body: gbp() }),
      "GET /api/bank/transactions": () => ({ body: txs([t]) }),
      "GET /api/bank/transactions/10": () => ({ body: txDetail(t) }),
    });
    const user = userEvent.setup();
    renderApp("/treasury/bank");
    const strip = await screen.findByRole("region", { name: "Balance by currency" });
    await within(strip).findByText(HIDDEN);
    expect(norm(strip.textContent)).not.toMatch(/about (-)?[€$£]|about -/i);
    const rowButton = await screen.findByRole("button", { name: /Cloud Inc/ });
    expect(norm((rowButton.closest("tr") as HTMLElement).textContent)).not.toMatch(
      /about (-)?[€$£]|about -/i,
    );
    await user.click(rowButton);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("No estimate: the ECB rates are 7 working days old");
    expect(norm(dialog.textContent)).not.toMatch(/about (-)?[€$£]|about -/i);
  });

  it("names the oldest rate date when the rates are stale but usable", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxStale()),
      "GET /api/bank/accounts": () => ({ body: gbp() }),
      "GET /api/bank/transactions": () => ({ body: txs([tx()]) }),
    });
    renderApp("/treasury/bank");
    const strip = await screen.findByRole("region", { name: "Balance by currency" });
    await waitFor(() =>
      expect(norm(strip.textContent)).toContain("in total at the ECB rates of 6 Nov"),
    );
    expect(norm(strip.textContent)).not.toContain("today's");
  });
});

const ITEMS: AgeingFixtureItem[] = [
  {
    relationId: 1,
    relationName: "Acme",
    currency: "EUR",
    openMinor: 100_001,
    dueDate: "2026-12-01",
  },
  {
    relationId: 2,
    relationName: "Beta",
    currency: "USD",
    openMinor: 10_007,
    dueDate: "2026-12-01",
  },
  { relationId: 2, relationName: "Beta", currency: "USD", openMinor: 5_003, dueDate: "2026-09-01" },
  {
    relationId: 3,
    relationName: "Gamma",
    currency: "GBP",
    openMinor: 7_011,
    dueDate: "2026-10-20",
  },
  {
    relationId: 4,
    relationName: "Delta",
    currency: "JPY",
    openMinor: 123_457,
    dueDate: "2026-06-01",
  },
  {
    relationId: 4,
    relationName: "Delta",
    currency: "JPY",
    openMinor: -3_001,
    dueDate: "2026-08-01",
  },
  { relationId: 5, relationName: "Eps", currency: "KWD", openMinor: 1_234, dueDate: "2026-10-01" },
];

/** "about € 1.092,14" / "about -€ 3,10" / "-" -> "1092.14" / "-3.10" / "" */
function screenNumber(cell: string): string {
  const t = norm(cell)
    .replace(/credit$/, "")
    .trim();
  if (!/\d/.test(t)) return "";
  const negative = /-/.test(t);
  const digits = t.replace(/[^\d,]/g, "").replace(",", ".");
  return `${negative ? "-" : ""}${digits}`;
}

function sheetRows(sheet: SheetSpec): string[][] {
  const zip = unzipSync(buildXlsx([sheet], { createdAt: new Date("2026-11-11T13:05:00Z") }));
  const doc = new DOMParser().parseFromString(
    strFromU8(zip["xl/worksheets/sheet1.xml"] as Uint8Array),
    "application/xml",
  );
  return Array.from(doc.getElementsByTagName("row"), (r) =>
    Array.from(r.getElementsByTagName("c"), (c) =>
      c.getAttribute("t") === "inlineStr"
        ? (c.getElementsByTagName("t")[0]?.textContent ?? "")
        : (c.getElementsByTagName("v")[0]?.textContent ?? ""),
    ),
  );
}

describe("ageing: the converted row on screen equals the Excel row, digit for digit", () => {
  for (const [name, resp] of [
    ["fresh", fxRates()],
    ["stale", fxStale()],
  ] as const) {
    it(`${name} rates`, async () => {
      const report = ageingResponse(ITEMS);
      mockFetch({
        ...me(),
        ...divs(),
        ...rates(resp),
        "GET /api/reports/ageing": () => ({ body: report }),
      });
      renderApp("/reporting/receivables-ageing");
      const heading = await screen.findByRole("heading", { name: /^Total in € at/, level: 2 });
      const card = heading.closest("section") as HTMLElement;
      const cells = Array.from(
        within(card).getAllByRole("row")[1]?.querySelectorAll("td") ?? [],
        (td) => screenNumber(td.textContent ?? ""),
      );
      expect(cells).toHaveLength(AGEING_BUCKETS.length + 1);

      // the Excel sheet the page would download, built from the same rates
      const table = rateTableFromResponse(resp) as NonNullable<
        ReturnType<typeof rateTableFromResponse>
      >;
      const t = ageingTotalsInBase(table, "EUR", report.currencies);
      if (!t) throw new Error("no totals");
      const fx = { ...t, wording: totalsWording(resp, t.rateDate) };
      const out = ageingExport(
        report,
        { administration: "Alpha BV", generatedAt: new Date(), syncedAt: null },
        "outstanding",
        fx,
      );
      const rows = sheetRows(out.sheets.at(-1) as SheetSpec);
      const title = norm(heading.textContent);
      const line = rows.find((r) => r[0] === title);
      expect(line, `Excel row titled "${title}"`).toBeDefined();
      expect((line as string[]).slice(1)).toEqual(cells);

      // the Total cross-foots: sum of the bucket cells
      const cents = (s: string) => (s === "" ? 0n : BigInt(s.replace(".", "")));
      const sum = cells.slice(0, -1).reduce((a, c) => a + cents(c), 0n);
      expect(cents(cells.at(-1) as string)).toBe(sum);
      if (name === "stale") {
        expect(title).toBe("Total in € at the ECB rates of 6 Nov");
      } else {
        // GBP's rate is of 6 Nov (older than the newest), so even fresh rates are dated here
        expect(title).toBe("Total in € at the ECB rates of 6 Nov");
      }
    });
  }

  it("is 'today's' when every rate used is the newest", async () => {
    const report = ageingResponse(ITEMS.filter((i) => i.currency !== "GBP"));
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxRates()),
      "GET /api/reports/ageing": () => ({ body: report }),
    });
    renderApp("/reporting/receivables-ageing");
    await screen.findByRole("heading", { name: "Total in € at today's ECB rates", level: 2 });
  });

  it("past the cut-off there is no converted card and no estimate on the page", async () => {
    mockFetch({
      ...me(),
      ...divs(),
      ...rates(fxOutage()),
      "GET /api/reports/ageing": () => ({ body: ageingResponse(ITEMS) }),
    });
    renderApp("/reporting/receivables-ageing");
    await screen.findByText(HIDDEN);
    expect(screen.queryByRole("heading", { name: /^Total in €/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/about €/);
  });
});
