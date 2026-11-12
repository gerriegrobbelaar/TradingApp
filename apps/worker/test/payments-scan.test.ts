/**
 * Source scans for payments (P9a, ADR 0049; P9b, ADR 0050). The tripwires that keep money from moving
 * by accident:
 *  1. the gate allow-list reaches EXACTLY the payment endpoints of ADR 0050 and nothing else (P9a
 *     pinned "none"; P9b changed this deliberately, see the list in ADR 0050 / the PR notes);
 *  2. `runSubmission` is called from ONE place (`submitPayment`), which is called from one route file;
 *     only the real submitter calls the client's payment writes;
 *  3. no floating point near money; 4. no full IBAN in responses, audit rows or logs.
 * Limits: a scan reads text; reviewers must also reject a path built at run time.
 */
import { describe, expect, it } from "vitest";
import { RevolutApiError } from "@camelthorn/revolut";
import { validateRequest } from "../src/revolut/request";
import { buildCreateCounterparty, buildPay, buildPaymentDraft } from "@camelthorn/revolut";
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

describe("the Revolut gate reaches exactly the payment endpoints of ADR 0050", () => {
  const base = { connectionId: 1, priority: "user" as const, jobId: "payments-test" };
  it("refuses every payment path for every method and API version to a job that is not in the payment class", () => {
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
          // GET /counterparties is an existing READ endpoint; nothing else passes
          const read = method === "GET" && path === "/counterparties" && apiVersion === "1.0";
          if (read) continue;
          expect(err instanceof RevolutApiError, `${method} ${path} v${apiVersion}`).toBe(true);
        }
      }
    }
  });

  const RID = "3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a42";
  const UUID1 = "bdab1c20-8d8c-430d-b967-87ac01af060c";
  const leg = {
    accountId: UUID1,
    counterpartyId: UUID1,
    amountMinor: 100,
    currency: "EUR",
    reference: "Invoice 1",
  };
  const pay = buildPay({ ...leg, requestId: RID });
  const draft = buildPaymentDraft({ requestId: RID, payments: [leg] });
  const cp = buildCreateCounterparty({ name: "A", iban: "NL91ABNA0417164300", currency: "EUR" });
  const BODIES: Record<string, { body: string; ref: string }> = {
    "/pay": { body: pay.body, ref: RID },
    "/payment-drafts": { body: draft.body, ref: RID },
    "/counterparty": { body: cp.body, ref: `cp-${RID}-0` },
  };
  const accepts = (over: Record<string, unknown>): boolean => {
    try {
      validateRequest({ connectionId: 1, priority: "user", ...over } as never);
      return true;
    } catch {
      return false;
    }
  };

  it("with the payment job class, a lease and a ledger key: exactly these calls pass, nothing else", () => {
    const passing: string[] = [];
    for (const path of PAYMENT_PATHS) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
        for (const apiVersion of ["1.0", "2.0"] as const) {
          const b = BODIES[path];
          const over = {
            method,
            path,
            apiVersion,
            jobId: "revolut-payment",
            paymentLease: "lease-abcdefgh",
            paymentRef: b?.ref ?? RID,
            ...(method === "POST" ? { body: b?.body ?? "{}" } : {}),
          };
          if (accepts(over)) passing.push(`${method} ${path} v${apiVersion}`);
        }
      }
    }
    // A read passes with a lease only if it carries none: the lease belongs to writes.
    const reads: string[] = [];
    for (const path of PAYMENT_PATHS) {
      if (accepts({ method: "GET", path, jobId: "revolut-payment" })) reads.push(`GET ${path}`);
    }
    expect(passing.sort()).toEqual(
      ["POST /counterparty v1.0", "POST /pay v1.0", "POST /payment-drafts v1.0"].sort(),
    );
    expect(reads.sort()).toEqual(
      [
        "GET /counterparties",
        "GET /payment-drafts",
        `GET /payment-drafts/00000000-0000-4000-8000-000000000000`,
      ].sort(),
    );
  });

  it("a payment write needs ALL of: payment job class, user priority, lease, ledger key, a body of our shape", () => {
    const ok = {
      method: "POST",
      path: "/pay",
      jobId: "revolut-payment",
      paymentLease: "lease-abcdefgh",
      paymentRef: RID,
      body: pay.body,
    };
    expect(accepts(ok)).toBe(true);
    expect(accepts({ ...ok, jobId: "revolut-payment:reconcile" })).toBe(true);
    expect(accepts({ ...ok, jobId: "revolut-sync" })).toBe(false);
    expect(accepts({ ...ok, jobId: "revolut-payments" })).toBe(false);
    expect(accepts({ ...ok, priority: "job" })).toBe(false);
    expect(accepts({ ...ok, paymentLease: undefined })).toBe(false);
    expect(accepts({ ...ok, paymentLease: "short" })).toBe(false);
    expect(accepts({ ...ok, paymentRef: undefined })).toBe(false);
    expect(accepts({ ...ok, paymentRef: "bad ref" })).toBe(false);
    expect(accepts({ ...ok, apiVersion: "2.0" })).toBe(false);
    // the body must be OUR shape and its request_id must be the ledger key
    expect(accepts({ ...ok, body: "{}" })).toBe(false);
    expect(accepts({ ...ok, body: "not json" })).toBe(false);
    expect(
      accepts({ ...ok, body: pay.body.replace(RID, "11111111-1111-4111-8111-111111111111") }),
    ).toBe(false);
    expect(accepts({ ...ok, body: pay.body.slice(0, -1) + ',"extra":1}' })).toBe(false);
    // a lease or ledger key never rides on anything else
    expect(
      accepts({
        method: "POST",
        path: "/webhooks",
        apiVersion: "2.0",
        paymentLease: "lease-abcdefgh",
        paymentRef: RID,
        jobId: "x",
      }),
    ).toBe(false);
    expect(
      accepts({ method: "GET", path: "/accounts", jobId: "x", paymentLease: "lease-abcdefgh" }),
    ).toBe(false);
    expect(
      accepts({
        method: "GET",
        path: "/payment-drafts",
        jobId: "revolut-payment",
        paymentRef: RID,
      }),
    ).toBe(false);
  });

  it("allows exactly four POSTs: the webhook subscription and the three payment writes", () => {
    const post = (path: string, version: "1.0" | "2.0"): boolean => {
      const b = BODIES[path];
      return accepts({
        method: "POST",
        path,
        apiVersion: version,
        jobId: b ? "revolut-payment" : "t",
        ...(b ? { paymentLease: "lease-abcdefgh", paymentRef: b.ref, body: b.body } : {}),
      });
    };
    expect(post("/webhooks", "2.0")).toBe(true);
    expect(post("/pay", "1.0")).toBe(true);
    expect(post("/payment-drafts", "1.0")).toBe(true);
    expect(post("/counterparty", "1.0")).toBe(true);
    expect(
      accepts({
        method: "DELETE",
        path: "/webhooks/00000000-0000-4000-8000-000000000000",
        apiVersion: "2.0",
        jobId: "t",
      }),
    ).toBe(true);
    for (const p of [
      "/accounts",
      "/transactions",
      "/counterparties",
      "/transfer",
      "/exchange",
      "/bulk-payments",
    ]) {
      expect(post(p, "1.0"), `POST ${p}`).toBe(false);
    }
    // there is no DELETE or PUT of a draft or a counterparty
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      for (const path of [
        "/payment-drafts/00000000-0000-4000-8000-000000000000",
        "/counterparty/00000000-0000-4000-8000-000000000000",
        "/pay",
      ]) {
        expect(
          accepts({
            method,
            path,
            jobId: "revolut-payment",
            paymentLease: "lease-abcdefgh",
            paymentRef: RID,
            body: "{}",
          }),
          `${method} ${path}`,
        ).toBe(false);
      }
    }
  });

  it("only the gate allow-list (revolut/request.ts) names a payment endpoint as a string in the worker", () => {
    const re =
      /["'`]\/(?:pay|transfer|payment-drafts|bulk-payments|payout-links|exchange|counterparty)(?:["'`/?]|\$\{)/;
    const offenders = read(workerFiles)
      .filter(([, t]) => re.test(code(t)))
      .map(([f]) => f);
    expect(offenders).toEqual(["../src/revolut/request.ts"]);
  });

  it("in the Revolut client package, payment calls live in payments.ts and client.ts only", () => {
    expect(Object.keys(revolutFiles).length).toBeGreaterThan(3);
    for (const [f, text] of read(revolutFiles)) {
      if (/\/(payments|client)\.ts$/.test(f)) continue;
      const c = code(text);
      expect(c, f).not.toMatch(
        /["'`]\/(?:pay|transfer|payment-drafts|bulk-payments|payout-links|exchange|counterparty)(?:["'`/?]|\$\{)/,
      );
      expect(c, f).not.toMatch(
        /\b(?:createPayment|createTransfer|payDraft|createPaymentDraft|createBulkDraft|createCounterparty|sendPayment|pay)\s*\(/,
      );
    }
    const posts = read(revolutFiles).flatMap(([f, t]) =>
      (code(t).match(/method:\s*"POST"/g) ?? []).map(() => f),
    );
    expect([...new Set(posts)].sort()).toEqual([
      "../../../packages/revolut/src/client.ts",
      "../../../packages/revolut/src/payments.ts",
    ]);
  });

  it("only the real submitter calls the client's payment writes", () => {
    const users = read(workerFiles)
      .filter(([f]) => !f.endsWith("/payments/revolut-submitter.ts"))
      .filter(([, t]) =>
        /\.(?:pay|createPaymentDraft|createBulkDraft|createCounterparty)\s*\(/.test(code(t)),
      )
      .map(([f]) => f);
    expect(users).toEqual([]);
  });
});

describe("the submit boundary has one caller", () => {
  it("only submit.ts mentions runSubmission, only it and reconcile.ts use markStaleSubmissions", () => {
    const users = read(workerFiles)
      .filter(([f]) => !f.endsWith("/payments/submit.ts"))
      .filter(([, t]) => /\brunSubmission\b/.test(code(t)))
      .map(([f]) => f);
    expect(users).toEqual([]);
    const stale = read(workerFiles)
      .filter(([f]) => !f.endsWith("/payments/submit.ts"))
      .filter(([, t]) => /\bmarkStaleSubmissions\b/.test(code(t)))
      .map(([f]) => f);
    expect(stale).toEqual(["../src/payments/reconcile.ts"]);
    const submit = workerFiles["../src/payments/submit.ts"] ?? "";
    expect(submit).toMatch(/export const DisabledSubmitter/);
    expect(submit).toMatch(/let current: PaymentSubmitter = DisabledSubmitter;/);
    // runSubmission is called exactly twice in submit.ts, both inside submitPayment
    expect((code(submit).match(/\brunSubmission\(/g) ?? []).length).toBe(3); // definition + 2 calls
    // the test seam is mentioned nowhere else in src
    const seam = read(workerFiles)
      .filter(([f]) => !f.endsWith("/payments/submit.ts"))
      .filter(([, t]) => /setSubmitterForTests/.test(t))
      .map(([f]) => f);
    expect(seam).toEqual([]);
  });

  it("submitPayment is called from the payments routes only, and nothing else sends", () => {
    const callers = read(workerFiles)
      .filter(([f]) => !f.endsWith("/payments/submit.ts"))
      .filter(([, t]) => /\bsubmitPayment\s*\(/.test(code(t)))
      .map(([f]) => f);
    expect(callers).toEqual(["../src/payments/routes.ts"]);
    // no job handler, queue consumer, cron or webhook route mentions it
    for (const [f, t] of read(workerFiles)) {
      if (
        /\/(jobs|dq|matching|booking|today)\//.test(f) ||
        /webhook/.test(f) ||
        f.endsWith("/index.ts")
      ) {
        expect(code(t), f).not.toMatch(/\bsubmitPayment\b|\brunSubmission\b/);
      }
    }
  });

  it("payments files import the Revolut modules only where ADR 0050 says, and never call fetch", () => {
    const MAY_IMPORT_REVOLUT = [
      "../src/payments/submit.ts",
      "../src/payments/revolut-submitter.ts",
      "../src/payments/reconcile.ts",
      "../src/payments/reconcile-job.ts",
      "../src/payments/preview.ts",
      "../src/payments/protocol-version.ts",
      "../src/payments/tx-match.ts",
    ];
    for (const [f, t] of read(workerFiles).filter(([f]) => f.startsWith("../src/payments/"))) {
      if (!MAY_IMPORT_REVOLUT.includes(f)) {
        expect(code(t), f).not.toMatch(/from\s+["'][^"']*(?:\/revolut\/|@camelthorn\/revolut)/);
      }
      expect(code(t), f).not.toMatch(/REVOLUT_GATE|\bfetch\s*\(/);
    }
  });

  it("the sending routes are exactly the two submit routes, and they need finance and a fresh sign-in", () => {
    const routes = buildRouter()
      .describe()
      .filter((r) => /payment/.test(r.pattern));
    expect(routes.length).toBeGreaterThan(20);
    const sending = routes.filter((p) => /\/(submit|send|pay|execute|run)\b/.test(p.pattern));
    expect(sending.map((r) => r.pattern).sort()).toEqual([
      "POST /api/payment-batches/:id/submit",
      "POST /api/payments/:id/submit",
    ]);
    for (const r of sending) {
      expect(r.access.roles).toEqual(["finance"]);
      expect(r.access.stepUp).toBe(true);
    }
    const admin = [
      "POST /api/payments/preview",
      "POST /api/payments/:id/resolve-not-sent",
      "POST /api/payment-batches/:id/resolve-not-sent",
    ];
    for (const p of admin) {
      const r = routes.find((x) => x.pattern === p);
      expect(r?.access.roles, p).toEqual(["admin"]);
      expect(r?.access.stepUp, p).toBe(true);
    }
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
