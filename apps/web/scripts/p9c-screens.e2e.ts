/**
 * P9c browser checks (see vitest.screens.config.ts): screenshots of the payment screens at 360 and
 * 1280 in light and dark, with axe INCLUDING colour contrast in the real browser, a check that the
 * page does not scroll sideways and that no request reached an unmocked path. Shots: Payables for
 * finance (Pay, tick boxes, the selection bar), the Pay sheet (account choice, switched off,
 * blocked, the confirmation with the typed phrase, a batch), payment approvals (list, decision
 * sheet, a payload that changed under the approver), bank details, Treasury payments (list, an
 * unconfirmed payment with its history) and
 * Settings, Payments (switched off, the loosening dialog). The API is mocked in the browser; the
 * app is the production build.
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
import { DEFAULT_SCENE, matchingApi } from "./matching-mock";
import { DEFAULT_PAY_SCENE, payMe, paymentsApi, type PayScene } from "./payments-mock";

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
  fill(sel: string, value: string): Promise<void>;
  close(): Promise<void>;
}
type Route = MockRoute & { request(): { url(): string; method(): string } };
interface Browser {
  newPage(o: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}

let server: Server;
let base = "";
let browser: Browser;

type Step =
  | "none"
  | "pay_prepare"
  | "pay_confirm"
  | "pay_blocked"
  | "pay_disabled"
  | "batch_confirm"
  | "decision"
  | "decision_moved"
  | "iban"
  | "payment_detail"
  | "loosen"
  | "send_open"
  | "send_done"
  | "verify_open"
  | "enable_open"
  | "preview_run";
interface Shot {
  name: string;
  path: string;
  scene?: Partial<PayScene>;
  ready: string;
  step?: Step;
  height?: number;
}

const D = "[role='dialog']";
const SHOTS: Shot[] = [
  { name: "payables-finance", path: "/purchases/payables", ready: "table tbody tr td button" },
  {
    name: "pay-prepare",
    path: "/purchases/payables",
    ready: "table tbody tr td button",
    step: "pay_prepare",
    height: 1400,
  },
  {
    name: "pay-disabled",
    path: "/purchases/payables",
    scene: { enabled: false },
    ready: "table tbody tr td button",
    step: "pay_disabled",
    height: 1200,
  },
  {
    name: "pay-blocked",
    path: "/purchases/payables",
    scene: { create: "blocked" },
    ready: "table tbody tr td button",
    step: "pay_blocked",
    height: 1800,
  },
  {
    name: "pay-confirm",
    path: "/purchases/payables",
    ready: "table tbody tr td button",
    step: "pay_confirm",
    height: 2000,
  },
  {
    name: "pay-confirm-stale",
    path: "/purchases/payables",
    scene: { stale: true },
    ready: "table tbody tr td button",
    step: "pay_confirm",
    height: 2200,
  },
  {
    name: "batch-confirm",
    path: "/purchases/payables",
    scene: { create: "batch" },
    ready: "table tbody tr td button",
    step: "batch_confirm",
    height: 2400,
  },
  {
    name: "approvals-payments",
    path: "/purchases/approvals?tab=payments",
    scene: { me: "approver" },
    ready: "table tbody tr td button",
    height: 1200,
  },
  {
    name: "approval-decision",
    path: "/purchases/approvals?tab=payments",
    scene: { me: "approver" },
    ready: "table tbody tr td button",
    step: "decision",
    height: 2200,
  },
  {
    name: "approval-payload-changed",
    path: "/purchases/approvals?tab=payments",
    scene: { me: "approver", payloadMoves: true },
    ready: "table tbody tr td button",
    step: "decision_moved",
    height: 2400,
  },
  {
    name: "bank-details",
    path: "/purchases/payables",
    scene: { me: "approver" },
    ready: "table tbody tr td button",
    step: "iban",
    height: 1400,
  },
  {
    name: "treasury-payments",
    path: "/treasury/bank?tab=payments",
    scene: { me: "viewer" },
    ready: "table tbody tr td button",
    height: 1400,
  },
  {
    name: "payment-unconfirmed",
    path: "/treasury/bank?tab=payments",
    scene: { me: "viewer", status: "outcome_unknown" },
    ready: "table tbody tr td button",
    step: "payment_detail",
    height: 2200,
  },
  {
    name: "send-confirm",
    path: "/treasury/bank?tab=payments",
    scene: { me: "finance", status: "ready" },
    ready: "table tbody tr td button",
    step: "send_open",
    height: 2200,
  },
  {
    name: "send-done",
    path: "/treasury/bank?tab=payments",
    scene: { me: "finance", status: "ready" },
    ready: "table tbody tr td button",
    step: "send_done",
    height: 2200,
  },
  {
    name: "send-unknown",
    path: "/treasury/bank?tab=payments",
    scene: { me: "finance", status: "ready", send: "unknown" },
    ready: "table tbody tr td button",
    step: "send_done",
    height: 2200,
  },
  {
    name: "send-refused",
    path: "/treasury/bank?tab=payments",
    scene: { me: "finance", status: "ready", send: "refused" },
    ready: "table tbody tr td button",
    step: "send_done",
    height: 2200,
  },
  {
    name: "paid-booking-pending",
    path: "/treasury/bank?tab=payments",
    scene: { me: "viewer", status: "paid_pending" },
    ready: "table tbody tr td button",
    step: "payment_detail",
    height: 2200,
  },
  {
    name: "paid-booked",
    path: "/treasury/bank?tab=payments",
    scene: { me: "viewer", status: "paid_booked" },
    ready: "table tbody tr td button",
    step: "payment_detail",
    height: 2200,
  },
  {
    name: "waiting-in-revolut",
    path: "/treasury/bank?tab=payments",
    scene: { me: "viewer", status: "ready", send: "ok" },
    ready: "table tbody tr td button",
    height: 1400,
  },
  {
    name: "settings-admin-tools",
    path: "/settings/payments",
    scene: { me: "admin", enabled: false, adminReady: true },
    ready: ".pay-unknown",
    height: 4200,
  },
  {
    name: "settings-verify",
    path: "/settings/payments",
    scene: { me: "admin", enabled: false },
    ready: ".pay-form",
    step: "verify_open",
    height: 3600,
  },
  {
    name: "settings-enable",
    path: "/settings/payments",
    scene: { me: "admin", enabled: false, adminReady: true },
    ready: ".pay-unknown",
    step: "enable_open",
    height: 1600,
  },
  {
    name: "settings-preview",
    path: "/settings/payments",
    scene: { me: "admin", enabled: false, adminReady: true },
    ready: ".pay-unknown",
    step: "preview_run",
    height: 4600,
  },
  {
    name: "settings-payments",
    path: "/settings/payments",
    scene: { me: "admin", enabled: false },
    ready: ".pay-form",
    height: 3000,
  },
  {
    name: "settings-loosen",
    path: "/settings/payments",
    scene: { me: "admin", enabled: true },
    ready: ".pay-form",
    step: "loosen",
    height: 3000,
  },
];

function api(method: string, path: string, search: URLSearchParams, scene: PayScene): unknown {
  if (method === "GET") {
    switch (path) {
      case "/api/auth/me":
        return payMe(scene);
      case "/api/divisions":
        return ONE_DIVISION;
      case "/api/fx/rates":
        return fxRates();
      case "/api/bank/accounts":
        return accounts();
    }
  }
  return paymentsApi(method, path, search, scene) ?? matchingApi(path, search, DEFAULT_SCENE);
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

async function openPay(page: Page, label: string): Promise<void> {
  await page.click(`button[aria-label^='${label}']`);
  await page.waitForSelector(`${D} input[type='radio']`, { timeout: 15_000 });
}
async function review(page: Page): Promise<void> {
  await page.click(`${D} input[type='radio']`);
  await page.click(`${D} button:has-text('Review payment')`);
}

describe("Payment screens", () => {
  for (const shot of SHOTS) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of [360, 1280] as const) {
        it(`${shot.name} ${theme} ${width}: renders, no console or CSP errors, no axe violations`, async () => {
          const scene: PayScene = { ...DEFAULT_PAY_SCENE, ...shot.scene };
          const page = await browser.newPage({
            viewport: { width, height: shot.height ?? 1000 },
          });
          const seen: string[] = [];
          page.on("console", (m) => {
            // A refused request (the 422 of a blocked payment) is logged by the browser itself.
            const refused =
              (scene.create.endsWith("blocked") && /status of 422/.test(m.text())) ||
              (scene.send === "refused" && /status of 409/.test(m.text()));
            if (m.type() === "error" && !refused) seen.push(m.text());
          });
          await page.addInitScript((t) => {
            localStorage.setItem("camelthorn.theme", t);
            document.addEventListener("securitypolicyviolation", (e) =>
              console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`),
            );
          }, theme);
          await page.route("**/api/**", async (route) => {
            const r = route.request();
            const url = new URL(r.url());
            const body = api(r.method(), url.pathname, url.searchParams, scene);
            if (body && typeof body === "object" && "__status" in body) {
              const { __status, ...rest } = body as { __status: number };
              await route.fulfill({
                status: __status,
                contentType: "application/json",
                body: JSON.stringify(rest),
              });
              return;
            }
            await answerApi(route, body);
          });
          await page.goto(`${base}${shot.path}`);
          await page.waitForSelector("h1", { timeout: 15_000 });
          await page.waitForSelector(shot.ready, { timeout: 15_000 });
          switch (shot.step) {
            case "pay_prepare":
              await openPay(page, "Pay BILL-77");
              await page.click(`${D} input[type='radio']`);
              break;
            case "pay_disabled":
              await page.click("button[aria-label^='Pay BILL-77']");
              await page.waitForSelector(`${D} [data-testid='payments-disabled']`, {
                timeout: 15_000,
              });
              break;
            case "pay_blocked":
              await openPay(page, "Pay BILL-77");
              await review(page);
              await page.waitForSelector(`${D} .pay-blocks`, { timeout: 15_000 });
              break;
            case "pay_confirm":
              await openPay(page, "Pay BILL-77");
              await review(page);
              await page.waitForSelector(`${D} [data-testid='pay-phrase']`, { timeout: 15_000 });
              await page.fill(`${D} input.input`, "PAY 1234.56 EUR TO 4300");
              break;
            case "batch_confirm":
              await page.click("input[aria-label='Select BILL-77 to pay']");
              await page.click("input[aria-label='Select BILL-78 to pay']");
              await page.click("button:has-text('Pay selected bills')");
              await page.waitForSelector(`${D} input[type='radio']`, { timeout: 15_000 });
              await review(page);
              await page.waitForSelector(`${D} [data-testid='pay-phrase']`, { timeout: 15_000 });
              break;
            case "decision":
              await page.click("table tbody tr td button");
              await page.waitForSelector(`${D} button:has-text('Approve payment')`, {
                timeout: 15_000,
              });
              break;
            case "decision_moved":
              await page.click("table tbody tr td button");
              await page.waitForSelector(`${D} button:has-text('Approve payment')`, {
                timeout: 15_000,
              });
              await page.click(`${D} button:has-text('Check status again')`);
              await page.waitForSelector(`${D} [data-testid='pay-payload-changed']`, {
                timeout: 15_000,
              });
              break;
            case "iban":
              await page.click("button[aria-label^='Bank details of Acme']");
              await page.waitForSelector(`${D} .pay-iban`, { timeout: 15_000 });
              break;
            case "payment_detail":
              await page.click("table tbody tr td button");
              await page.waitForSelector(`${D} .pay-timeline`, { timeout: 15_000 });
              break;
            case "send_open":
            case "send_done":
              await page.click("table tbody tr td button");
              await page.waitForSelector(`${D} button:has-text('Send to bank')`, {
                timeout: 15_000,
              });
              await page.click(`${D} button:has-text('Send to bank')`);
              await page.waitForSelector(`${D} [data-testid='send-next']`, { timeout: 15_000 });
              if (shot.step === "send_done") {
                await page.click(`${D} button:has-text('Create the draft in Revolut')`);
                await page.waitForSelector(`${D} [data-testid='send-result']`, {
                  timeout: 15_000,
                });
              }
              break;
            case "verify_open":
              await page.click("button:has-text('Record the verification')");
              await page.waitForSelector(`${D} .pay-verify`, { timeout: 15_000 });
              break;
            case "enable_open":
              await page.click("button:has-text('Switch payments on')");
              await page.waitForSelector(`${D} input.input`, { timeout: 15_000 });
              break;
            case "preview_run":
              await page.fill("label:has-text('Request number') input", "11");
              await page.click("button:has-text('Preview')");
              await page.waitForSelector("[data-testid='preview-result']", { timeout: 15_000 });
              break;
            case "loosen":
              await page.fill("input[inputmode='decimal']", "3000");
              await page.click("button:has-text('Save changes')");
              await page.waitForSelector(`${D} input.input`, { timeout: 15_000 });
              break;
            default:
              break;
          }
          // Let the sheet finish sliding in: axe reads colours mid-animation otherwise.
          await page.evaluate("new Promise((r) => setTimeout(r, 700))");
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
            path: join(OUT, `p9c-${shot.name}-${theme}-${width}.png`),
            fullPage: true,
          });
          await page.close();
        });
      }
    }
  }
});
