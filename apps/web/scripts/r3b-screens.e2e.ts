/**
 * R3b browser checks (see vitest.screens.config.ts): screenshots of Treasury, Bank at 360 and 1280
 * in light and dark in four states (populated, not connected, waiting for the first sync, the
 * transaction sheet), plus axe with colour contrast in the real browser and a check that the page
 * does not scroll sideways. The API is mocked in the browser; the app is the production build.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { answerApi, takeUnmocked, type MockRoute } from "./api-mock";
import { fxRates } from "../src/test-fixtures-fx";

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
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate<T>(fn: (() => T) | string): Promise<T>;
  waitForSelector(sel: string, o?: { timeout?: number }): Promise<unknown>;
  click(sel: string): Promise<void>;
  close(): Promise<void>;
}
type Route = MockRoute;
interface Browser {
  newPage(o: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}

let server: Server;
let base = "";
let browser: Browser;

type State = "populated" | "none" | "waiting" | "sheet";
const NOW = Date.now();
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const FRESH = { lastCompletedAt: iso(4), basis: [], stale: false, staleAfterHours: 2 };
const NEVER = { lastCompletedAt: null, basis: [], stale: true, staleAfterHours: 2 };
const CONN = { id: 1, status: "active", createsBankEntries: false, paymentsMode: "drafts" };
const ACCOUNTS = [
  {
    id: 1,
    name: "Main EUR",
    currency: "EUR",
    balanceMinor: 1234567,
    balanceAt: iso(4),
    state: "active",
    ibanMasked: "NL••••••••••1234",
    isActive: true,
  },
  {
    id: 2,
    name: "Sterling",
    currency: "GBP",
    balanceMinor: 50025,
    balanceAt: iso(4),
    state: "active",
    ibanMasked: "GB••••5678",
    isActive: true,
  },
  {
    id: 3,
    name: "Old dollars",
    currency: "USD",
    balanceMinor: 0,
    balanceAt: iso(900),
    state: "inactive",
    ibanMasked: null,
    isActive: false,
  },
];
const TX = (over: Record<string, unknown>) => ({
  externalId: "x",
  legId: "l",
  accountId: 1,
  accountName: "Main EUR",
  type: "transfer",
  state: "completed",
  isFinal: true,
  createdAt: iso(300),
  completedAt: iso(299),
  amountMinor: -12345,
  currency: "EUR",
  reference: "INV-2026-0042",
  description: "Office supplies",
  counterpartyName: "Paper Co",
  counterpartyIbanMasked: "NL••••••••••9876",
  ...over,
});
const ITEMS = [
  TX({
    id: 1,
    externalId: "a",
    amountMinor: 250000,
    counterpartyName: "Client BV",
    reference: "Invoice 2026-118",
  }),
  TX({ id: 2, externalId: "b" }),
  TX({
    id: 3,
    externalId: "c",
    state: "pending",
    isFinal: false,
    completedAt: null,
    amountMinor: -9900,
    counterpartyName: "Cloud hosting",
    reference: "Nov hosting",
  }),
  TX({
    id: 4,
    externalId: "d",
    state: "declined",
    amountMinor: -50000,
    counterpartyName: "Travel agent",
    reference: null,
  }),
  TX({
    id: 5,
    externalId: "e",
    legId: "l1",
    amountMinor: -50000,
    counterpartyName: "Own GBP",
    reference: "Top up",
  }),
  TX({
    id: 6,
    externalId: "e",
    legId: "l2",
    amountMinor: 43000,
    currency: "GBP",
    accountId: 2,
    accountName: "Sterling",
    counterpartyName: "Own EUR",
    reference: "Top up",
  }),
  TX({
    id: 7,
    externalId: "f",
    state: "reverted",
    amountMinor: 1500,
    counterpartyName: "Refund shop",
    reference: "Return",
  }),
];

function api(path: string, state: State): unknown {
  switch (path) {
    case "/api/auth/me":
      return ADMIN;
    case "/api/divisions":
      return { selectedId: null, divisions: [] };
    case "/api/fx/rates":
      // F3 added a rates request to every signed-in screen: a screen without this mock logs a
      // console 404 (review S2). A realistic, fresh answer (rates of 10 Nov 2026).
      return fxRates();
    case "/api/bank/accounts":
      if (state === "none") {
        return {
          connection: null,
          accounts: [],
          totalsByCurrency: [],
          freshness: NEVER,
          available: false,
        };
      }
      if (state === "waiting") {
        return {
          connection: CONN,
          accounts: [],
          totalsByCurrency: [],
          freshness: NEVER,
          available: false,
        };
      }
      return {
        connection: CONN,
        accounts: ACCOUNTS,
        totalsByCurrency: [
          { currency: "EUR", balanceMinor: 1234567, accounts: 1 },
          { currency: "GBP", balanceMinor: 50025, accounts: 1 },
        ],
        freshness: FRESH,
        available: true,
      };
    case "/api/bank/transactions":
      return {
        items: ITEMS,
        nextCursor: null,
        total: ITEMS.length,
        totalsByCurrency: [
          { currency: "EUR", inMinor: 251500, outMinor: 122245, count: 6 },
          { currency: "GBP", inMinor: 43000, outMinor: 0, count: 1 },
        ],
        freshness: FRESH,
        available: true,
      };
    case "/api/bank/transactions/5":
      return {
        ...ITEMS[4],
        legs: [ITEMS[4], ITEMS[5]],
        firstSeenAt: iso(299),
        lastEventAt: iso(298),
        source: "webhook",
      };
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

// Every request the screens made was answered by a mock (no 404 for a forgotten path).
afterEach(() => {
  expect(takeUnmocked()).toEqual([]);
});

describe("Treasury, Bank", () => {
  for (const state of ["populated", "none", "waiting", "sheet"] as const) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of [360, 1280] as const) {
        it(`${state} ${theme} ${width}: renders, no console or CSP errors, no axe violations`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 1000 } });
          const seen: string[] = [];
          page.on("console", (m) => {
            if (m.type() === "error") seen.push(m.text());
          });
          await page.addInitScript((t) => {
            localStorage.setItem("camelthorn.theme", t);
            document.addEventListener("securitypolicyviolation", (e) =>
              console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`),
            );
          }, theme);
          await page.route("**/api/**", async (route) => {
            const url = new URL(route.request().url());
            const body = api(url.pathname, state);
            await answerApi(route, body);
          });
          await page.goto(`${base}/treasury/bank`);
          await page.waitForSelector("h1", { timeout: 15_000 });
          if (state === "populated" || state === "sheet") {
            await page.waitForSelector("table tbody tr td button", { timeout: 15_000 });
          } else {
            await page.waitForSelector(".empty", { timeout: 15_000 });
          }
          if (state === "sheet") {
            await page.click("button[data-row-primary='5']");
            await page.waitForSelector("[role='dialog'] .dl-row", { timeout: 15_000 });
            await page.waitForSelector("[role='dialog'] table", { timeout: 15_000 });
          }
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
          expect(seen).toEqual([]);
          await page.screenshot({
            path: join(OUT, `r3b-bank-${state}-${theme}-${width}.png`),
            fullPage: true,
          });
          await page.close();
        });
      }
    }
  }
});
