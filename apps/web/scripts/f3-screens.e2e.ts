/**
 * F3 browser checks (see vitest.screens.config.ts): screenshots at 360 and 1280 in light and dark of
 * the live FX amounts (Overview, item sheets, ageing, Bank) and Settings, FX rates (ok, stale,
 * never imported), plus axe WITH colour contrast in the real browser, no sideways page scroll, no
 * console or CSP errors, and a reduced-motion pass. The API is mocked in the browser; the app is
 * the production build. Files: docs/design/screens/f3-<scene>-<theme>-<width>.png
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KpiAmountDto } from "@camelthorn/core";
import { account, accounts, tx, txDetail, txs } from "../src/test-fixtures-bank";
import {
  fxHistory,
  fxNever,
  fxOutage,
  fxRates,
  fxStale,
  importJob,
  jobsResponse,
} from "../src/test-fixtures-fx";
import { ageingResponse } from "../src/test-fixtures-reports";
import { ONE_DIVISION, detail, kpis, listResponse, overview, row } from "../src/test-fixtures";

const ADMIN = {
  email: "gerrie.grobbelaar@camelthorncapital.com",
  roles: ["admin"],
  stepUpFresh: true,
  allowedDomain: "camelthorncapital.com",
};
const here = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(here, "../dist");
const OUT = process.env["OUT_DIR"] ?? resolve(here, "../../../docs/design/screens");
const CHROME = process.env["CHROME_PATH"] ?? "/usr/bin/google-chrome";

interface Page {
  goto(url: string): Promise<unknown>;
  route(glob: string, fn: (r: Route) => Promise<void> | void): Promise<void>;
  on(e: "console", fn: (m: { type(): string; text(): string }) => void): void;
  addInitScript(fn: (arg: string) => void, arg: string): Promise<void>;
  emulateMedia(o: { reducedMotion?: "reduce" | "no-preference" }): Promise<void>;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate<T>(fn: (() => T) | string): Promise<T>;
  waitForSelector(sel: string, o?: { timeout?: number }): Promise<unknown>;
  click(sel: string): Promise<void>;
  close(): Promise<void>;
}
interface Route {
  request(): { url(): string };
  fulfill(o: { status?: number; contentType?: string; body: string }): Promise<void>;
}
interface Browser {
  newPage(o: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}

let server: Server;
let base = "";
let browser: Browser;

const amt = (minor: number, dc: number, complete = true, count = 1): KpiAmountDto => ({
  count,
  minor,
  dcMinor: dc,
  dcComplete: complete,
});
const usd = (path: "/api/invoices" | "/api/bills") =>
  kpis(path, "USD", {
    total: amt(1_250_000, 1_130_000, true, 4),
    overdue: amt(310_000, 280_000, true, 1),
    due7: amt(0, 0, true, 0),
    due30: amt(400_000, 0, false, 2),
  });
const gbp = (path: "/api/invoices" | "/api/bills") =>
  kpis(path, "GBP", { total: amt(500_000, 575_000, true, 2) });

const USD_INV = row({
  id: 1,
  invoiceNumber: "INV-2041",
  currency: "USD",
  originalMinor: 1_000_000,
  openMinor: 1_000_000,
  dcMinor: 900_000,
  relation: { id: 7, name: "Hudson Trading LLC" },
});
const EUR_INV = row({ id: 2, invoiceNumber: "INV-2042" });
const USD_BILL = row({
  id: 3,
  kind: "bill",
  invoiceNumber: "BILL-771",
  currency: "USD",
  originalMinor: 1_000_000,
  openMinor: 1_000_000,
  dcMinor: 900_000,
  relation: { id: 8, name: "Cloud Hosting Inc" },
});
const AGEING_ITEMS = [
  {
    relationId: 1,
    relationName: "Acme BV",
    currency: "EUR",
    openMinor: 1_000_000,
    dueDate: "2026-12-01",
  },
  {
    relationId: 2,
    relationName: "Hudson Trading LLC",
    currency: "USD",
    openMinor: 1_000_000,
    dueDate: "2026-12-01",
  },
  {
    relationId: 2,
    relationName: "Hudson Trading LLC",
    currency: "USD",
    openMinor: 250_000,
    dueDate: "2026-09-01",
  },
  {
    relationId: 3,
    relationName: "Thames Ltd",
    currency: "GBP",
    openMinor: 700_000,
    dueDate: "2026-11-01",
  },
];
const BANK_TX = tx({
  id: 10,
  currency: "USD",
  amountMinor: -123_456,
  counterpartyName: "Cloud Inc",
});

type Scene =
  | "overview"
  | "item-receivable"
  | "item-payable"
  | "ageing"
  | "bank"
  | "fx-ok"
  | "fx-stale"
  | "fx-never"
  | "list-stale"
  | "overview-outage"
  | "page-error";

const PATH: Record<Scene, string> = {
  overview: "/overview",
  "item-receivable": "/invoices",
  "item-payable": "/purchases/payables",
  ageing: "/reporting/receivables-ageing",
  bank: "/treasury/bank",
  "fx-ok": "/settings/fx",
  "fx-stale": "/settings/fx",
  "fx-never": "/settings/fx",
  "list-stale": "/invoices",
  "overview-outage": "/overview",
  "page-error": "/overview",
};

function api(pathname: string, scene: Scene): unknown {
  switch (pathname) {
    case "/api/auth/me":
      return ADMIN;
    case "/api/divisions":
      return ONE_DIVISION;
    case "/api/fx/rates":
      return scene === "fx-stale"
        ? { ...fxStale(), lastImportStatus: "error", lastImportCode: "rate_not_published" }
        : scene === "list-stale"
          ? fxStale()
          : scene === "overview-outage"
            ? fxOutage()
            : scene === "fx-never"
              ? fxNever()
              : fxRates();
    case "/api/fx/history":
      return fxHistory("USD", 5);
    case "/api/jobs":
      return jobsResponse([importJob()]);
    case "/api/overview":
      // A well-formed JSON answer with the wrong shape: the Overview throws while rendering and
      // the page boundary has to catch it (review S2).
      if (scene === "page-error") return { kpis: null, division: null, freshness: null };
      return overview({
        kpis: {
          receivable: [kpis("/api/invoices"), usd("/api/invoices"), gbp("/api/invoices")],
          payable: [kpis("/api/bills"), usd("/api/bills")],
        },
      });
    case "/api/invoices":
      return listResponse([USD_INV, EUR_INV]);
    case "/api/bills":
      return listResponse([USD_BILL]);
    case "/api/open-items/1":
      return detail(USD_INV, { rate: "0.9" });
    case "/api/open-items/3":
      return detail(USD_BILL);
    case "/api/reports/ageing":
      return ageingResponse(AGEING_ITEMS);
    case "/api/bank/accounts":
      return accounts([
        account(),
        account({ id: 2, name: "Sterling", currency: "GBP", balanceMinor: 50_025 }),
      ]);
    case "/api/bank/transactions":
      return txs([BANK_TX]);
    case "/api/bank/transactions/10":
      return txDetail(BANK_TX);
    default:
      return null;
  }
}

function assetHeaders(): [string, string][] {
  const out: [string, string][] = [];
  for (const line of readFileSync(resolve(here, "../public/_headers"), "utf8").split("\n")) {
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (m) out.push([m[1] as string, (m[2] as string).trim()]);
  }
  return out;
}
const HEADERS = assetHeaders();

const req = createRequire(import.meta.url);
const AXE = readFileSync(
  createRequire(req.resolve("vitest-axe")).resolve("axe-core/axe.min.js"),
  "utf8",
);
interface AxeResult {
  violations: { id: string; impact: string; nodes: { target: string[] }[] }[];
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
  server = createServer((rq, res) => {
    const url = new URL(rq.url ?? "/", "http://x");
    let file = join(DIST, url.pathname);
    if (!file.startsWith(DIST) || !existsSync(file) || url.pathname === "/")
      file = join(DIST, "index.html");
    res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
    for (const [k, v] of HEADERS) res.setHeader(k, v);
    res.end(readFileSync(file));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const pw = (await import(
    process.env["PLAYWRIGHT_PATH"]
      ? pathToFileURL(process.env["PLAYWRIGHT_PATH"]).href
      : "playwright"
  )) as { chromium: { launch(o: { executablePath: string }): Promise<Browser> } };
  browser = await pw.chromium.launch({ executablePath: CHROME });
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function open(scene: Scene, theme: "light" | "dark", width: number, reduced = false) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const seen: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") seen.push(m.text());
  });
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((t) => {
    localStorage.setItem("camelthorn.theme", t);
    document.addEventListener("securitypolicyviolation", (e) =>
      console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`),
    );
  }, theme);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const body = api(url.pathname, scene);
    await route.fulfill({
      status: body === null ? 404 : 200,
      contentType: "application/json",
      body: JSON.stringify(body ?? { error: "not_found" }),
    });
  });
  await page.goto(`${base}${PATH[scene]}`);
  await page.waitForSelector("h1", { timeout: 15_000 });
  switch (scene) {
    case "overview":
      await page.waitForSelector(".fx-headline:not([data-fx-pending])", { timeout: 15_000 });
      break;
    case "item-receivable":
    case "item-payable":
      await page.waitForSelector(".fx-row:not([data-fx-pending])", { timeout: 15_000 });
      await page.click(`button[data-row-primary='${scene === "item-receivable" ? 1 : 3}']`);
      await page.waitForSelector("[role='dialog'] .fx-amount", { timeout: 15_000 });
      break;
    case "ageing":
      await page.waitForSelector(".fx-ageing", { timeout: 15_000 });
      break;
    case "bank":
      await page.waitForSelector(".fx-bank-total:not([data-fx-pending])", { timeout: 15_000 });
      break;
    case "fx-ok":
      await page.waitForSelector(".fx-chart", { timeout: 15_000 });
      break;
    case "fx-stale":
      await page.waitForSelector(".chip.warn", { timeout: 15_000 });
      break;
    case "fx-never":
      await page.waitForSelector(".empty", { timeout: 15_000 });
      break;
    case "list-stale":
      await page.waitForSelector(".fx-page-chip", { timeout: 15_000 });
      await page.waitForSelector(".fx-row:not([data-fx-pending])", { timeout: 15_000 });
      break;
    case "overview-outage":
      await page.waitForSelector(".fx-page-chip", { timeout: 15_000 });
      break;
    case "page-error":
      await page.waitForSelector("[role='alert']", { timeout: 15_000 });
      break;
  }
  // Review F3: no placeholder line may be left once the rates are in.
  await page.waitForSelector("body:not(:has([data-fx-pending]))", { timeout: 15_000 });
  return { page, seen };
}

describe("F3 FX screens", () => {
  const scenes: Scene[] = [
    "overview",
    "item-receivable",
    "item-payable",
    "ageing",
    "bank",
    "fx-ok",
    "fx-stale",
    "fx-never",
    "list-stale",
    "overview-outage",
    "page-error",
  ];
  for (const scene of scenes) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of [360, 1280] as const) {
        it(`${scene} ${theme} ${width}: renders, no overflow, no console or CSP errors, no axe violations`, async () => {
          const { page, seen } = await open(scene, theme, width);
          const overflow = await page.evaluate<number>(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          const axe = await page.evaluate<AxeResult>(
            `${AXE};axe.run(document, { resultTypes: ["violations"] })`,
          );
          expect(
            axe.violations.map(
              (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
            ),
          ).toEqual([]);
          // page-error logs the error NAME once (and nothing else); every other scene is silent
          const allowed = scene === "page-error" ? /^ui render error: TypeError$/ : /404/;
          expect(seen.filter((m) => !allowed.test(m))).toEqual([]);
          if (scene === "page-error") {
            expect(seen).toEqual(["ui render error: TypeError"]);
            // the menu is still there and the fallback has no error text
            expect(
              await page.evaluate<number>(() => document.querySelectorAll("nav a").length),
            ).toBeGreaterThan(3);
            expect(await page.evaluate<string>(() => document.body.innerText)).toContain(
              "Something went wrong on this page. Reload, or go back.",
            );
          }
          await page.screenshot({
            path: join(OUT, `f3-${scene}-${theme}-${width}.png`),
            fullPage: true,
          });
          await page.close();
        });
      }
    }
  }

  it("reduced motion: the FX tab renders with the same content", async () => {
    const { page } = await open("fx-ok", "light", 360, true);
    const animated = await page.evaluate<number>(
      () =>
        Array.from(document.querySelectorAll(".fx-chart, .fx-chart *")).filter((el) => {
          const s = getComputedStyle(el);
          return s.animationName !== "none" || parseFloat(s.transitionDuration) > 0;
        }).length,
    );
    expect(animated).toBe(0);
    await page.close();
  });
});
