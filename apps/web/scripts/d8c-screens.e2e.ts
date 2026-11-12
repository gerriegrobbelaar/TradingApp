/**
 * D8c browser checks (see vitest.screens.config.ts): screenshots of Today (queue, empty, error-free
 * loading, keyboard selection, a postponed item) and Data health (full, never run, empty issues,
 * issue sheet, rule settings with the loosening phrase) at 360 and 1280 in light and dark, with axe
 * INCLUDING colour contrast in the real browser, a check that the page does not scroll sideways, and
 * keyboard checks in a real browser (J, K, L, Z). The API is mocked; the app is the production build.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { answerApi, takeUnmocked, type MockRoute } from "./api-mock";
import { ONE_DIVISION } from "../src/test-fixtures";
import { fxRates } from "../src/test-fixtures-fx";
import {
  dqIssue,
  dqIssues,
  dqRules,
  dqSummary,
  mixedQueue,
  notifications,
  todayResponse,
} from "../src/test-fixtures-dq";

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
  fill(sel: string, value: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
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

type Scene = "full" | "empty" | "nocheck" | "limited";

function api(path: string, scene: Scene): unknown {
  switch (path) {
    case "/api/auth/me":
      return ADMIN;
    case "/api/divisions":
      return ONE_DIVISION;
    case "/api/fx/rates":
      return fxRates();
    case "/api/today":
      if (scene === "limited") {
        // Review D8c: an empty queue that could not vouch for everything says so.
        return todayResponse([], {
          dqLastRun: null,
          approvalMappingVerified: false,
          notChecked: ["approval", "booking"],
        });
      }
      return scene === "empty" ? todayResponse([]) : todayResponse(mixedQueue());
    case "/api/dq/summary":
      return scene === "nocheck"
        ? dqSummary(
            { lastRun: null, open: { info: 0, warning: 0, critical: 0 }, snoozed: 0 },
            Object.fromEntries(
              dqSummary().rules.map((r) => [
                r.ruleId,
                { status: "never_run", evaluatedAt: null, checked: 0 },
              ]),
            ),
          )
        : dqSummary(
            {},
            {
              "receivables.bounced_emails": {
                status: "not_available",
                reason: "email_log_empty_until_phase_10",
              },
              "ledger.suspense_not_zero": {
                status: "not_configured",
                reason: "no_suspense_accounts_configured",
              },
              "bank.unmatched_old": { status: "issues", openIssues: 1 },
              "payables.supplier_iban_changed": { status: "issues", openIssues: 1 },
            },
          );
    case "/api/dq/issues":
      return scene === "full"
        ? dqIssues([
            dqIssue(),
            dqIssue({
              id: 2,
              severity: "critical",
              message: "1 supplier IBAN changed",
              subject: "Acme B.V.",
              area: "payables",
              ruleId: "payables.supplier_iban_changed",
              fix: "payables",
              fixPath: "/purchases/payables",
            }),
          ])
        : dqIssues([]);
    case "/api/dq/rules":
      return dqRules();
    case "/api/dq/notifications":
      // Review V2: the API key is never part of the answer, only whether it is set.
      return scene === "empty"
        ? notifications(
            { apiKeyPresent: false, senderActive: false },
            { emailProvider: "disabled", emailHost: "", emailFrom: "" },
          )
        : notifications();
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
  violations: {
    id: string;
    impact: string;
    nodes: { target: string[]; any?: { message: string }[] }[];
  }[];
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

type Step =
  "none" | "notify-confirm" | "j" | "later" | "issue" | "rule" | "critical-rule" | "today-sheet";
interface Shot {
  name: string;
  path: string;
  scene?: Scene;
  ready: string;
  step?: Step;
  height?: number;
}

const SHOTS: Shot[] = [
  { name: "today", path: "/", ready: "[role='option']" },
  { name: "today-keyboard", path: "/today", ready: "[role='option']", step: "j" },
  { name: "today-later", path: "/today", ready: "[role='option']", step: "later" },
  {
    name: "today-sheet",
    path: "/today",
    ready: "[role='option']",
    step: "today-sheet",
    height: 1400,
  },
  { name: "today-empty", path: "/today", scene: "empty", ready: ".empty" },
  { name: "today-limited", path: "/today", scene: "limited", ready: ".today-limits" },
  {
    name: "health",
    path: "/data-health",
    ready: ".dt-table tbody tr:not(.sk-row) td",
    height: 2600,
  },
  {
    name: "health-nocheck",
    path: "/data-health",
    scene: "nocheck",
    ready: ".empty",
    height: 2600,
  },
  {
    name: "health-empty",
    path: "/data-health",
    scene: "empty",
    ready: ".empty",
    height: 2600,
  },
  {
    name: "health-issue",
    path: "/data-health",
    ready: "button[data-row-primary='1']",
    step: "issue",
    height: 1600,
  },
  {
    name: "health-rule",
    path: "/data-health",
    ready: "button[aria-label^='Settings for']:not([disabled])",
    step: "rule",
    height: 1600,
  },
  {
    name: "settings-notifications",
    path: "/settings/notifications",
    ready: "#nt-host-hint",
    height: 1800,
  },
  {
    name: "settings-notifications-unset",
    path: "/settings/notifications",
    scene: "empty",
    ready: "#nt-host-hint",
    height: 1800,
  },
  {
    name: "settings-notifications-confirm",
    path: "/settings/notifications",
    ready: "#nt-host-hint",
    step: "notify-confirm",
    height: 1800,
  },
  {
    name: "health-rule-critical",
    path: "/data-health",
    ready: "button[aria-label^='Settings for']:not([disabled])",
    step: "critical-rule",
    height: 1800,
  },
];

describe("Today and Data health", () => {
  for (const shot of SHOTS) {
    for (const theme of ["light", "dark"] as const) {
      for (const width of [360, 1280] as const) {
        it(`${shot.name} ${theme} ${width}: renders, no console or CSP errors, no axe violations`, async () => {
          const scene: Scene = shot.scene ?? "full";
          const page = await browser.newPage({ viewport: { width, height: shot.height ?? 1000 } });
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
            await answerApi(route, api(url.pathname, scene));
          });
          await page.goto(`${base}${shot.path}`);
          await page.waitForSelector("h1", { timeout: 15_000 });
          await page.waitForSelector(shot.ready, { timeout: 15_000 });
          if (shot.step === "j") {
            await page.keyboard.press("j");
            await page.waitForSelector("[role='option'][aria-selected='true'][id$='dq-4']", {
              timeout: 5_000,
            });
          }
          if (shot.step === "later") {
            await page.keyboard.press("l");
            await page.waitForSelector(".toast", { timeout: 5_000 });
            // Let the toast finish fading in: axe would measure a colour half-way.
            await page.evaluate("new Promise((r) => setTimeout(r, 800))");
          }
          if (shot.step === "today-sheet") {
            await page.keyboard.press("j");
            await page.keyboard.press("a");
            await page.waitForSelector("[role='dialog'] a:has-text('Fix')", { timeout: 5_000 });
          }
          if (shot.step === "issue") {
            await page.click("button[data-row-primary='1']");
            await page.waitForSelector("[role='dialog'] a:has-text('Fix')", { timeout: 5_000 });
          }
          if (shot.step === "rule") {
            await page.click("button[aria-label^='Settings for']:not([disabled])");
            await page.waitForSelector("[role='dialog'] [role='switch']", { timeout: 5_000 });
          }
          if (shot.step === "notify-confirm") {
            await page.fill("input[aria-describedby='nt-host-hint']", "mail.other.example.org");
            await page.click("button[type='submit']");
            await page.waitForSelector("[role='dialog'] strong", { timeout: 5_000 });
          }
          if (shot.step === "critical-rule") {
            await page.click("button[aria-label='Settings for Supplier bank details changed']");
            await page.waitForSelector("[role='dialog'] [role='switch']", { timeout: 5_000 });
            await page.click("[role='dialog'] [role='switch']");
            await page.waitForSelector("[role='dialog'] .notice.warn", { timeout: 5_000 });
          }
          // Review V2: let sheets, focus rings and toasts finish their transitions first. On a
          // loaded machine axe otherwise measured a button colour half-way (4.27:1, flaky).
          await page.evaluate(
            `Promise.race([
              Promise.all(
                document
                  .getAnimations()
                  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                  .map((a) => a.finished.catch(() => undefined)),
              ),
              new Promise((r) => setTimeout(r, 3000)),
            ])`,
          );
          const overflow = await page.evaluate<number>(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          const axe = await page.evaluate<AxeResult>(
            `${AXE};axe.run(document, { resultTypes: ["violations"] })`,
          );
          expect(
            axe.violations.map(
              (v) =>
                `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.any?.[0]?.message ?? ""}`).join(", ")}`,
            ),
          ).toEqual([]);
          expect(seen).toEqual([]);
          await page.screenshot({
            path: join(OUT, `d8c-${shot.name}-${theme}-${width}.png`),
            fullPage: true,
          });
          await page.close();
        });
      }
    }
  }
});

describe("Today keyboard in a real browser", () => {
  it("J moves focus, L postpones with a toast, Z brings the item back", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.addInitScript(() => localStorage.setItem("camelthorn.theme", "light"), "");
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      await answerApi(route, api(url.pathname, "full"));
    });
    await page.goto(`${base}/today`);
    await page.waitForSelector("[role='option']", { timeout: 15_000 });
    const count = () =>
      page.evaluate<number>(() => document.querySelectorAll("[role='option']").length);
    expect(await count()).toBe(4);
    await page.keyboard.press("j");
    await page.waitForSelector("[role='option'][aria-selected='true'][id$='dq-4']");
    // Focus follows in the effect after the selection renders: wait for it (flaky under load).
    await page.waitForSelector("[role='option'][id$='dq-4']:focus", { timeout: 5_000 });
    expect(await page.evaluate<string>(() => document.activeElement?.id ?? "")).toMatch(/dq-4$/);
    await page.keyboard.press("l");
    await page.waitForSelector(".toast");
    expect(await count()).toBe(3);
    await page.keyboard.press("z");
    await page.waitForSelector("[role='option'][id$='dq-4']");
    expect(await count()).toBe(4);
    await page.close();
  });
});
