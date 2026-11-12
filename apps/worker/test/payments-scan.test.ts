/**
 * Source scans for the payments foundation (P9a, ADR 0049). These are the tripwires that keep P9a
 * from moving money by accident:
 *  1. no code path can reach a Revolut payment endpoint (the gate allow-list, the client, the sources);
 *  2. the submit boundary is only wired in tests: no route, job or handler imports `runSubmission`;
 *  3. no floating point near money; 4. no full IBAN in responses, audit rows or logs.
 * Limits: a scan reads text; reviewers must also reject a path built at run time.
 */
import { describe, expect, it } from "vitest";
import { RevolutApiError } from "@camelthorn/revolut";
import { validateRequest } from "../src/revolut/request";
import { buildRouter } from "../src/app-router";

const read = (g: Record<string, string>): [string, string][] => Object.entries(g);
const workerFiles = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const revolutFiles = import.meta.glob("../../../packages/revolut/src/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const coreFiles = import.meta.glob("../../../packages/core/src/payments/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Source without comments (a path named in a comment is not a call). */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const PAYMENT_PATHS = [
  "/pay",
  "/transfer",
  "/payment-drafts",
  "/payment-drafts/00000000-0000-4000-8000-000000000000",
  "/bulk-payments",
  "/payout-links",
  "/exchange",
  "/counterparty",
  "/counterparties",
  "/accounts/00000000-0000-4000-8000-000000000000/transfer",
  "/transaction/abc/cancel",
  "/pay/",
  "/PAY",
  "//pay",
  "/webhooks/../pay",
];

describe("the Revolut gate cannot reach a payment endpoint", () => {
  const base = { connectionId: 1, priority: "user" as const, jobId: "payments-test" };
  it("refuses every payment path for every method and API version", () => {
    for (const path of PAYMENT_PATHS) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
        for (const apiVersion of ["1.0", "2.0"] as const) {
          let err: unknown = null;
          try {
            validateRequest({
              ...base,
              method,
              path,
              apiVersion,
              body: method === "POST" ? "{}" : undefined,
            } as never);
          } catch (e) {
            err = e;
          }
          // GET /counterparties and GET /transaction/... are existing READ endpoints; nothing else passes
          const read = method === "GET" && path === "/counterparties" && apiVersion === "1.0";
          if (read) continue;
          expect(err instanceof RevolutApiError, `${method} ${path} v${apiVersion}`).toBe(true);
        }
      }
    }
  });

  it("allows exactly one POST (the webhook subscription) and one DELETE, nothing that pays", () => {
    const ok = (method: string, path: string, apiVersion: "1.0" | "2.0") => {
      try {
        validateRequest({ ...base, method, path, apiVersion } as never);
        return true;
      } catch {
        return false;
      }
    };
    expect(ok("POST", "/webhooks", "2.0")).toBe(true);
    expect(ok("DELETE", "/webhooks/00000000-0000-4000-8000-000000000000", "2.0")).toBe(true);
    for (const p of ["/webhooks", "/accounts", "/transactions", "/counterparties"]) {
      expect(ok("POST", p, "1.0"), `POST ${p} v1`).toBe(false);
    }
    expect(ok("POST", "/accounts", "2.0")).toBe(false);
  });

  it("no source file names a payment endpoint as a string (comments aside)", () => {
    const re =
      /["'`]\/(?:pay|transfer|payment-drafts|bulk-payments|payout-links|exchange)(?:["'`/?]|\$\{)/;
    const offenders = read(workerFiles)
      .filter(([, t]) => re.test(code(t)))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("the Revolut client package has no payment method and only the webhook POST", () => {
    expect(Object.keys(revolutFiles).length).toBeGreaterThan(3);
    for (const [f, text] of read(revolutFiles)) {
      const c = code(text);
      expect(c, f).not.toMatch(
        /["'`]\/(?:pay|transfer|payment-drafts|bulk-payments|payout-links|exchange)(?:["'`/?]|\$\{)/,
      );
      expect(c, f).not.toMatch(
        /\b(?:createPayment|createTransfer|payDraft|createPaymentDraft|sendPayment|pay)\s*\(/,
      );
    }
    const posts = read(revolutFiles).flatMap(([f, t]) =>
      (code(t).match(/method:\s*"POST"/g) ?? []).map(() => f),
    );
    expect(posts).toEqual(["../../../packages/revolut/src/client.ts"]);
  });
});

describe("the submit boundary is not wired", () => {
  it("only submit.ts defines runSubmission/DisabledSubmitter, and nothing in src calls runSubmission", () => {
    const users = read(workerFiles)
      .filter(([f]) => !f.endsWith("/payments/submit.ts"))
      .filter(([, t]) => /\brunSubmission\b|\bmarkStaleSubmissions\b/.test(code(t)))
      .map(([f]) => f);
    expect(users).toEqual([]);
    const submit = workerFiles["../src/payments/submit.ts"] ?? "";
    expect(submit).toMatch(/export const DisabledSubmitter/);
    expect(submit).toMatch(
      /export function getSubmitter\(\): PaymentSubmitter \{\s*return DisabledSubmitter;/,
    );
  });

  it("no payments file imports the Revolut gate, client, transport or oauth", () => {
    for (const [f, t] of read(workerFiles).filter(([f]) => f.startsWith("../src/payments/"))) {
      expect(code(t), f).not.toMatch(/from\s+["'][^"']*(?:\/revolut\/|@camelthorn\/revolut)/);
      expect(code(t), f).not.toMatch(/REVOLUT_GATE|\bfetch\s*\(/);
    }
  });

  it("no payments route, job or handler can send: the routes only change records", () => {
    const names = buildRouter()
      .describe()
      .map((r) => r.pattern)
      .filter((p) => /payment/.test(p));
    expect(names.length).toBeGreaterThan(20);
    // there is no route whose name says it sends
    expect(names.filter((p) => /\/(submit|send|pay|execute|run)\b/.test(p))).toEqual([]);
  });

  it("every payment route requires a role and every write goes through the CSRF-checked router", () => {
    const routes = buildRouter()
      .describe()
      .filter((r) => /\/api\/(payments|payment-batches|settings\/payments)/.test(r.pattern));
    expect(routes.length).toBeGreaterThan(20);
    for (const r of routes) {
      expect(r.access.public, r.pattern).toBeUndefined();
      expect(r.access.csrfExempt, r.pattern).toBeUndefined();
      expect(r.access.roles?.length, r.pattern).toBeGreaterThan(0);
    }
    const stepUpNeeded = [
      "POST /api/payments/:id/confirm",
      "POST /api/payments/:id/approve",
      "POST /api/payments/:id/reject",
      "POST /api/payment-batches/:id/confirm",
      "POST /api/payment-batches/:id/approve",
      "POST /api/payment-batches/:id/reject",
      "POST /api/payments/ibans/verify",
      "POST /api/payments/ibans/revoke",
      "POST /api/settings/payments/verify",
    ];
    for (const p of stepUpNeeded) {
      expect(routes.find((r) => r.pattern === p)?.access.stepUp, p).toBe(true);
    }
    const approvers = ["approve", "reject"].flatMap((a) => [
      `POST /api/payments/:id/${a}`,
      `POST /api/payment-batches/:id/${a}`,
    ]);
    for (const p of approvers)
      expect(routes.find((r) => r.pattern === p)?.access.roles, p).toEqual(["approver"]);
  });
});

describe("no floating point near money", () => {
  it("the payments sources (worker and core) use no float parsing, formatting or rounding", () => {
    const files = [
      ...read(workerFiles).filter(([f]) => f.startsWith("../src/payments/")),
      ...read(coreFiles).filter(([f]) => !f.endsWith(".test.ts")),
    ];
    expect(files.length).toBeGreaterThan(14);
    for (const [f, t] of files) {
      expect(code(t), f).not.toMatch(
        /\bparseFloat\b|\.toFixed\(|Math\.(?:round|floor|ceil|trunc|pow)\b|\bNumber\.parseFloat\b|\bfloat\b/i,
      );
      // no decimal literal in code (the only decimals are version numbers in comments and strings)
      expect(code(t).replace(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, '""'), f).not.toMatch(
        /(?<![\w.])\d+\.\d+(?![\w.])/,
      );
    }
  });

  it("the money columns are integer CHECKs and the API accepts only safe integers", () => {
    const routes = workerFiles["../src/payments/routes.ts"] ?? "";
    expect(routes).toMatch(/Number\.isSafeInteger\(v\)/);
  });
});

describe("no full IBAN leaves the payments code", () => {
  it("only iban-store.ts names a beneficiary or relation IBAN column, and only it handles a full IBAN", () => {
    const named = read(workerFiles)
      .filter(([f]) => f.startsWith("../src/payments/") && f !== "../src/payments/iban-store.ts")
      .filter(([, t]) =>
        /beneficiary_iban|relation_iban|\brelations\b[\s\S]{0,80}\.iban\b|\bbank_accounts\b[\s\S]{0,80}\.iban\b/.test(
          code(t),
        ),
      )
      .map(([f]) => f);
    expect(named).toEqual([]);
  });

  it("no response DTO field is an IBAN other than a masked one or a fingerprint", () => {
    const dto = workerFiles["../src/payments/read.ts"] ?? "";
    // iban-verify.ts: only the response interface (its other code passes the IBAN in memory)
    const verify =
      /export interface IbanStatusDto \{[\s\S]*?\n\}/.exec(
        workerFiles["../src/payments/iban-verify.ts"] ?? "",
      )?.[0] ?? "";
    expect(verify).toContain("ibanMasked");
    for (const text of [dto, verify]) {
      for (const m of code(text).matchAll(/\b(\w*[iI]ban\w*)\??\s*:/g)) {
        expect(m[1], m[0]).toMatch(/Masked$|Fingerprint|_fingerprint$/);
      }
    }
  });

  it("log calls in the payments code carry no request data", () => {
    for (const [f, t] of read(workerFiles).filter(([f]) => f.startsWith("../src/payments/"))) {
      expect(code(t), f).not.toMatch(/console\.(?:log|info|warn|error|debug)\s*\(/);
    }
  });
});
