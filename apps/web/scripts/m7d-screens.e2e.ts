/**
 * M7d browser checks (see vitest.screens.config.ts): screenshots of the Bank matching tabs (review
 * queue, match sheet with candidates and manual allocation, state conflict, automatic matches
 * populated and empty, ignored) and Settings, Matching (every card, booking off / blocked / ready,
 * the booking queue) at 360 and 1280 in light and dark, with axe INCLUDING colour contrast in the
 * real browser and a check that the page does not scroll sideways. The API is mocked in the
 * browser; the app is the production build.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { answerApi, takeUnmocked, type MockRoute } from "./api-mock";
import { fxRates } from "../src/test-fixtures-fx";
import { accounts } from "../src/test-fixtures-bank";
import { ONE_DIVISION } from "../src/test-fixtures";
import { DEFAULT_SCENE, matchingApi, pickerApi, type MatchScene } from "./matching-mock";

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

type Step = "none" | "select" | "manual" | "conflict" | "ledger";
interface Shot {
  name: string;
  path: string;
  scene?: Partial<MatchScene>;
  /** What must be on the page before the picture. */
  ready: string;
  step?: Step;
  height?: number;
}

const SHOTS: Shot[] = [
  { name: "review", path: "/treasury/bank?tab=review", ready: "table tbody tr td button" },
  {
    name: "sheet-candidates",
    path: "/treasury/bank?tab=review",
    ready: "table tbody tr td button",
    step: "select",
    height: 1800,
  },
  {
    name: "sheet-manual",
    path: "/treasury/bank?tab=review",
    ready: "table tbody tr td button",
    step: "manual",
    height: 2400,
  },
  {
    name: "sheet-conflict",
    path: "/treasury/bank?tab=review",
    ready: "table tbody tr td button",
    step: "conflict",
    height: 1400,
  },
  { name: "auto-populated", path: "/treasury/bank?tab=auto", ready: "table tbody tr td button" },
  {
    name: "auto-empty",
    path: "/treasury/bank?tab=auto",
    scene: { auto: "empty" },
    ready: ".empty",
  },
  { name: "ignored", path: "/treasury/bank?tab=ignored", ready: "table tbody tr td button" },
  {
    name: "settings-matching",
    path: "/settings/matching",
    ready: ".mt-outbox table tbody tr td",
    height: 3600,
  },
  {
    name: "booking-off",
    path: "/settings/matching",
    scene: { booking: "off" },
    ready: ".mt-outbox table tbody tr td",
    height: 3600,
  },
  {
    name: "booking-blocked",
    path: "/settings/matching",
    scene: { booking: "blocked" },
    ready: ".mt-outbox table tbody tr td",
    height: 3600,
  },
  {
    name: "booking-ready",
    path: "/settings/matching",
    scene: { booking: "ready", autoEnabled: true },
    ready: ".mt-outbox table tbody tr td",
    height: 3600,
  },
];

function api(path: string, search: URLSearchParams, scene: MatchScene): unknown {
  switch (path) {
    case "/api/auth/me":
      return ADMIN;
    case "/api/divisions":
      return ONE_DIVISION;
    case "/api/fx/rates":
      return fxRates();
    case "/api/bank/accounts":
      return accounts();
    default:
      return matchingApi(path, search, scene) ?? pickerApi(path);
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

describe("Bank matching and Settings, Matching", () => {
  for (const shot of SHOTS) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of [360, 1280] as const) {
        it(`${shot.name} ${theme} ${width}: renders, no console or CSP errors, no axe violations`, async () => {
          const scene: MatchScene = { ...DEFAULT_SCENE, ...shot.scene };
          const page = await browser.newPage({
            viewport: { width, height: shot.height ?? 1000 },
          });
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
            await answerApi(route, api(url.pathname, url.searchParams, scene));
          });
          await page.goto(`${base}${shot.path}`);
          await page.waitForSelector("h1", { timeout: 15_000 });
          await page.waitForSelector(shot.ready, { timeout: 15_000 });
          if (shot.step === "select" || shot.step === "manual" || shot.step === "ledger") {
            await page.click("button[data-row-primary='1']");
            await page.waitForSelector("[role='dialog'] input[type='radio']", { timeout: 15_000 });
            if (shot.step === "select") {
              await page.click("[role='dialog'] input[type='radio']");
            }
            if (shot.step === "manual") {
              await page.click("[role='dialog'] button:has-text('Match to another invoice')");
              await page.waitForSelector("[role='dialog'] .mt-picker-row", { timeout: 15_000 });
              await page.click("[role='dialog'] button[aria-label='Add INV-21']");
              await page.click("[role='dialog'] button[aria-label='Add INV-22']");
              await page.waitForSelector("[role='dialog'] .mt-alloc-row", { timeout: 15_000 });
            }
          }
          if (shot.step === "conflict") {
            await page.click("button[data-row-primary='2']");
            await page.waitForSelector("[role='dialog'] .mt-conflict", { timeout: 15_000 });
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
            path: join(OUT, `m7d-${shot.name}-${theme}-${width}.png`),
            fullPage: true,
          });
          await page.close();
        });
      }
    }
  }
});
