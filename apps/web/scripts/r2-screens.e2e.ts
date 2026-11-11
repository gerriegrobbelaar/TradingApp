/**
 * R2 browser checks (see vitest.screens.config.ts): screenshots of Settings, Connections with the
 * Revolut Business card at 360 and 1280 in light and dark, in five states (not connected, connected,
 * needs re-authorisation, waiting for the admin's confirmation, and Revolut not configured on the
 * deployment), plus axe (with colour contrast) in the real browser. The API
 * is mocked in the browser; the app is the production build in dist/.
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

type State = "none" | "connected" | "reauth" | "pending" | "unconfigured";
const PENDING = {
  until: "2026-11-11T09:15:00.000Z",
  stagedBy: "gerrie.grobbelaar@camelthorncapital.com",
  ref: "screens-ref",
  summary: {
    accountCount: 3,
    currencies: ["EUR", "GBP", "USD"],
    holders: ["Camelthorn Advisory B.V."],
    accounts: [
      { name: "Main", currency: "EUR", state: "active", last4: "5678" },
      { name: "Sterling", currency: "GBP", state: "active", last4: "1290" },
      { name: "Dollars", currency: "USD", state: "inactive", last4: null },
    ],
    previousAccounts: 0,
    matchingAccounts: 0,
    stateEchoed: false,
  },
};
const revolutRow = (state: State) =>
  state === "none" || state === "unconfigured"
    ? []
    : state === "pending"
      ? [
          {
            kind: "revolut",
            name: "revolut",
            status: "pending",
            expiresAt: null,
            lastError: null,
            connectedBy: null,
            connectedAt: null,
            divisions: [],
            revolut: {
              environment: "production",
              createsBankEntries: false,
              paymentsMode: "drafts",
              pending: PENDING,
            },
          },
        ]
      : [
          {
            kind: "revolut",
            name: "revolut",
            status: state === "connected" ? "active" : "needs_reauth",
            expiresAt: null,
            lastError: state === "connected" ? null : "invalid_grant",
            connectedBy: ADMIN.email,
            connectedAt: "2026-11-11T09:00:00.000Z",
            divisions: [],
            revolut: {
              environment: "production",
              createsBankEntries: false,
              paymentsMode: "drafts",
            },
          },
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
    case "/api/connections":
      return {
        exactConfigured: true,
        revolutConfigured: state !== "unconfigured",
        connections: revolutRow(state),
      };
    case "/api/sync/settings":
      return { incrementalOpenItems: false };
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

describe("Settings, Connections, Revolut Business card", () => {
  for (const state of ["none", "connected", "reauth", "pending", "unconfigured"] as const) {
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
          await page.goto(`${base}/settings/connections`);
          await page.waitForSelector("#revolut-heading", { timeout: 15_000 });
          await page.waitForSelector(
            state === "pending"
              ? "input[type='checkbox']"
              : state === "unconfigured"
                ? "#revolut-heading ~ * .notice, .notice.warn"
                : "input[name='revolut-bank-entries']",
            { timeout: 15_000 },
          );
          // No page-level sideways scroll at phone width.
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
            path: join(OUT, `r2-revolut-${state}-${theme}-${width}.png`),
            fullPage: true,
          });
          await page.close();
        });
      }
    }
  }
});
