/**
 * K3b browser checks (see vitest.screens.config.ts): screenshots of the four reporting screens at
 * 360 and 1280 in light and dark, phone-width scrolling, and the print stylesheet through
 * page.pdf(): orientation, page count, clipped columns, light-only colours, repeated headers.
 * The API is mocked in the browser; the app is the production build in dist/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@camelthorn/core";
import { ONE_DIVISION, listResponse, row } from "../src/test-fixtures";
import {
  accountBalancesResponse,
  ageingResponse,
  balanceSheetResponse,
  chartResponse,
  profitLossResponse,
  type AgeingFixtureItem,
} from "../src/test-fixtures-reports";

const VIEWER = {
  email: "v@camelthorncapital.com",
  roles: ["viewer"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};
const here = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(here, "../dist");
const OUT = process.env["OUT_DIR"] ?? resolve(here, "../../../docs/design/screens");
const CHROME = process.env["CHROME_PATH"] ?? "/usr/bin/google-chrome";
const AS_OF = "2026-11-11";

// Minimal structural types for the parts of Playwright used here.
interface Page {
  goto(url: string): Promise<unknown>;
  route(glob: string, fn: (r: Route) => Promise<void> | void): Promise<void>;
  addInitScript(fn: (arg: string) => void, arg: string): Promise<void>;
  emulateMedia(o: { media?: "print" | "screen"; colorScheme?: "light" | "dark" }): Promise<void>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  pdf(o: { path: string; preferCSSPageSize: boolean; printBackground: boolean }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  waitForSelector(sel: string, o?: { timeout?: number }): Promise<unknown>;
  getByRole(role: string, o?: { name?: string | RegExp }): Locator;
  keyboard: { press(k: string): Promise<void> };
  close(): Promise<void>;
}
interface Locator {
  first(): Locator;
  click(): Promise<void>;
  waitFor(): Promise<void>;
}
interface Route {
  request(): { url(): string };
  fulfill(o: { status?: number; contentType?: string; body: string }): Promise<void>;
  continue(): Promise<void>;
}
interface Browser {
  newPage(o: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}

let server: Server;
let base = "";
let browser: Browser;

function ageingItems(n: number): AgeingFixtureItem[] {
  const items: AgeingFixtureItem[] = [];
  const dues = [20, 5, 0, -10, -40, -75, -120, null] as const;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const d = dues[(i + k) % dues.length];
      items.push({
        relationId: i + 1,
        relationName: `Relation ${String(i + 1).padStart(3, "0")} Trading and Consulting B.V.`,
        currency: "EUR",
        openMinor:
          ((i * 7919 + k * 1301) % 900_000) + 1_000 - (k === 2 && i % 5 === 0 ? 20_000 : 0),
        dueDate: d === null ? null : addDays(AS_OF, -d),
      });
    }
  }
  items.push(
    {
      relationId: 900,
      relationName: "Pacific Imports Inc.",
      currency: "USD",
      openMinor: 1_250_000,
      dueDate: addDays(AS_OF, -33),
      dcMinor: 1_150_000,
    },
    {
      relationId: 901,
      relationName: "Tokyo Kōgyō KK",
      currency: "JPY",
      openMinor: 4_500_000,
      dueDate: addDays(AS_OF, -12),
    },
  );
  return items;
}

function api(path: string, search: URLSearchParams): unknown {
  switch (path) {
    case "/api/auth/me":
      return VIEWER;
    case "/api/divisions":
      return ONE_DIVISION;
    case "/api/reports/ageing":
      return ageingResponse(
        search.get("kind") === "payable" ? ageingItems(9) : ageingItems(11),
        search.get("kind") === "payable" ? "payable" : "receivable",
      );
    case "/api/reports/balance-sheet":
      return balanceSheetResponse();
    case "/api/reports/profit-loss":
      return profitLossResponse();
    case "/api/ledger/accounts":
      return chartResponse();
    case "/api/invoices":
    case "/api/bills":
      return listResponse([
        row({
          id: 1,
          invoiceNumber: "INV-1001",
          relation: { id: 1, name: "Relation 001 Trading and Consulting B.V." },
          openMinor: 125_000,
          dueDate: addDays(AS_OF, -12),
          bucket: "d1_30",
          daysOverdue: 12,
        }),
        row({
          id: 2,
          invoiceNumber: "INV-1002",
          relation: { id: 1, name: "Relation 001 Trading and Consulting B.V." },
          openMinor: 80_000,
          dueDate: addDays(AS_OF, -20),
          bucket: "d1_30",
          daysOverdue: 20,
        }),
      ]);
    default: {
      const m = /^\/api\/ledger\/accounts\/(\d+)\/balances$/.exec(path);
      if (m) return accountBalancesResponse(Number(m[1]));
      return null;
    }
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

beforeAll(async () => {
  if (!existsSync(join(DIST, "index.html")))
    throw new Error("Run `pnpm --filter @camelthorn/web build` first");
  mkdirSync(OUT, { recursive: true });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let file = join(DIST, url.pathname);
    if (!file.startsWith(DIST) || !existsSync(file) || url.pathname === "/")
      file = join(DIST, "index.html");
    res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const pw = (await import(
    process.env["PLAYWRIGHT_PATH"]
      ? pathToFileURL(process.env["PLAYWRIGHT_PATH"]).href
      : "playwright"
  )) as {
    chromium: { launch(o: { executablePath: string }): Promise<Browser> };
  };
  browser = await pw.chromium.launch({ executablePath: CHROME });
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function open(
  path: string,
  o: { width: number; height?: number; theme: "light" | "dark"; items?: number },
) {
  const page = await browser.newPage({ viewport: { width: o.width, height: o.height ?? 900 } });
  await page.addInitScript((t) => localStorage.setItem("camelthorn.theme", t), o.theme);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const body = api(url.pathname, url.searchParams);
    await route.fulfill({
      status: body === null ? 404 : 200,
      contentType: "application/json",
      body: JSON.stringify(body ?? { error: "not_found" }),
    });
  });
  await page.goto(`${base}${path}`);
  await page.waitForSelector(".report-table", { timeout: 15_000 });
  return page;
}

const REPORTS = [
  { slug: "creditors-ageing", path: "/reporting/creditors-ageing", landscape: true },
  { slug: "receivables-ageing", path: "/reporting/receivables-ageing", landscape: true },
  { slug: "balance-sheet", path: "/reporting/balance-sheet", landscape: false },
  { slug: "profit-loss", path: "/reporting/profit-loss", landscape: true },
] as const;

describe("screens", () => {
  for (const r of REPORTS) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of [360, 1280] as const) {
        it(`${r.slug} ${theme} ${width}: no page-level sideways scroll, table scrolls in its own region`, async () => {
          const page = await open(r.path, { width, theme });
          const m = await page.evaluate(() => {
            const regions = [...document.querySelectorAll<HTMLElement>(".report-scroll")];
            return {
              pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
              regions: regions.map((e) => ({
                scrolls: e.scrollWidth > e.clientWidth,
                focusable: e.tabIndex === 0,
                name: e.getAttribute("aria-label"),
              })),
            };
          });
          expect(m.pageOverflow, "page-level horizontal scroll").toBeLessThanOrEqual(0);
          expect(m.regions.length).toBeGreaterThan(0);
          for (const region of m.regions) expect(region.focusable).toBe(true);
          if (width === 360) expect(m.regions.some((x) => x.scrolls)).toBe(true);
          await page.screenshot({
            path: join(OUT, `k3b-${r.slug}-${theme}-${width}.png`),
            fullPage: true,
          });
          await page.close();
        });
      }
    }
  }

  it("drill-down sheet (ageing) and account sheet (balance sheet), 1280 light and 360 dark", async () => {
    const a = await open("/reporting/receivables-ageing", { width: 1280, theme: "light" });
    await a
      .getByRole("button", { name: /Relation 001.*1–30 days/ })
      .first()
      .click();
    await a.waitForSelector('[role="dialog"] .drill-list');
    await a.screenshot({ path: join(OUT, "k3b-receivables-ageing-sheet-light-1280.png") });
    await a.close();

    const b = await open("/reporting/balance-sheet", { width: 360, theme: "dark" });
    await b
      .getByRole("button", { name: /1100 Bank ING/ })
      .first()
      .click();
    await b.waitForSelector('[role="dialog"] .report-scroll');
    await b.screenshot({ path: join(OUT, "k3b-balance-sheet-account-sheet-dark-360.png") });
    await b.close();
  });
});

function pdfInfo(file: string): { pages: number; width: number; height: number } {
  const out = execFileSync("pdfinfo", [file], { encoding: "utf8" });
  const pages = Number(/Pages:\s+(\d+)/.exec(out)?.[1]);
  const size = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(out);
  return { pages, width: Number(size?.[1]), height: Number(size?.[2]) };
}

describe("print stylesheet", () => {
  for (const r of REPORTS) {
    it(`${r.slug}: ${r.landscape ? "A4 landscape" : "A4 portrait"}, nothing clipped, light and plain even in dark mode`, async () => {
      const page = await open(r.path, { width: 1280, theme: "dark" });
      // A4 in CSS pixels, so layout checks see the page width.
      await page.emulateMedia({ media: "print", colorScheme: "dark" });
      await page.setViewportSize(
        r.landscape ? { width: 1123, height: 794 } : { width: 794, height: 1123 },
      );
      const m = await page.evaluate(() => {
        const cs = (e: Element) => getComputedStyle(e);
        const body = cs(document.body);
        const table = document.querySelector<HTMLElement>(".report-table");
        const region = document.querySelector<HTMLElement>(".report-scroll");
        const card = document.querySelector<HTMLElement>(".card");
        const cells = [
          ...document.querySelectorAll<HTMLElement>(".report-table th, .report-table td"),
        ];
        const tableRight = table ? table.getBoundingClientRect().right : 0;
        return {
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          bg: body.backgroundColor,
          ink: body.color,
          hidden: {
            nav: cs(document.querySelector("nav") as Element).display,
            bar: cs(document.querySelector(".report-bar") as Element).display,
            meta: cs(document.querySelector(".print-meta") as Element).display,
          },
          effects: card ? { backdrop: cs(card).backdropFilter, shadow: cs(card).boxShadow } : null,
          tableRight,
          viewport: window.innerWidth,
          regionScroll: region ? region.scrollWidth - region.clientWidth : 0,
          clippedCells: cells.filter((c) => c.getBoundingClientRect().right > tableRight + 1)
            .length,
          stickyCells: cells.filter((c) => cs(c).position === "sticky").length,
          mixShown: [...document.querySelectorAll<HTMLElement>(".mix-col")].some(
            (e) => cs(e).display !== "none",
          ),
        };
      });
      expect(m.pageOverflow, "page wider than the sheet").toBeLessThanOrEqual(0);
      expect(m.bg).toBe("rgb(255, 255, 255)");
      expect(m.ink).toBe("rgb(0, 0, 0)");
      expect(m.hidden).toEqual({ nav: "none", bar: "none", meta: "block" });
      expect(m.effects?.backdrop ?? "none").toBe("none");
      expect(m.effects?.shadow ?? "none").toBe("none");
      expect(m.tableRight).toBeLessThanOrEqual(m.viewport);
      expect(m.regionScroll).toBeLessThanOrEqual(0);
      expect(m.clippedCells).toBe(0);
      expect(m.stickyCells).toBe(0);
      expect(m.mixShown).toBe(false);

      const file = join(tmpdir(), `k3b-${r.slug}.pdf`);
      await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
      const info = pdfInfo(file);
      // A4 is 595.28 x 841.89 pt.
      const [w, h] = r.landscape ? [841.89, 595.28] : [595.28, 841.89];
      expect(Math.abs(info.width - w)).toBeLessThan(2);
      expect(Math.abs(info.height - h)).toBeLessThan(2);
      // One page; the ageing fixture has three currency tables, which need two.
      expect(info.pages).toBe(r.slug.endsWith("ageing") ? 2 : 1);
      const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
      expect(text).toContain("Administration: Alpha BV");
      expect(text).toContain("Source: Exact Online");
      expect(text).toContain(`Page 1 of ${info.pages}`);
      execFileSync("pdftoppm", [
        "-png",
        "-r",
        "70",
        "-f",
        "1",
        "-l",
        "1",
        "-singlefile",
        file,
        join(OUT, `k3b-print-${r.slug}`),
      ]);
      await page.close();
    });
  }

  it("a long ageing report breaks across pages: header repeats, rows are not split", async () => {
    const page = await browser.newPage({ viewport: { width: 1123, height: 794 } });
    await page.addInitScript((t) => localStorage.setItem("camelthorn.theme", t), "light");
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const body =
        url.pathname === "/api/reports/ageing"
          ? ageingResponse(ageingItems(90), "receivable")
          : api(url.pathname, url.searchParams);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body ?? {}) });
    });
    await page.goto(`${base}/reporting/receivables-ageing`);
    await page.waitForSelector(".report-table");
    await page.emulateMedia({ media: "print" });
    const file = join(tmpdir(), "k3b-long.pdf");
    await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
    const info = pdfInfo(file);
    expect(info.pages).toBeGreaterThan(2);
    for (let p = 1; p <= info.pages; p++) {
      const text = execFileSync(
        "pdftotext",
        ["-layout", "-f", String(p), "-l", String(p), file, "-"],
        { encoding: "utf8" },
      );
      expect(text, `page ${p} header`).toContain("Not due");
      expect(text).toContain(`Page ${p} of ${info.pages}`);
    }
    // Every relation appears once, whole, with its total on the same line.
    const all = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
    for (const n of [1, 45, 90]) {
      const name = `Relation ${String(n).padStart(3, "0")}`;
      const lines = all.split("\n").filter((l) => l.includes(name));
      expect(lines, name).toHaveLength(1);
      expect(lines[0]).toMatch(/€\s*[\d.]+,\d\d\s+\S*\s*$|€\s*[\d.]+,\d\d/);
    }
    writeFileSync(join(tmpdir(), "k3b-long.txt"), all);
    execFileSync("pdftoppm", [
      "-png",
      "-r",
      "60",
      "-f",
      "2",
      "-l",
      "2",
      "-singlefile",
      file,
      join(OUT, "k3b-print-receivables-ageing-page2"),
    ]);
    await page.close();
  });
});
