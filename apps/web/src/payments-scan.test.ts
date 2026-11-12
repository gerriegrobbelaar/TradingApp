/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * P9c (ADR 0051): the payment screens do no floating-point arithmetic on money, never hold a full
 * IBAN, never store anything in the browser, and never print secrets or request data. A source
 * scan of every payment file, with the few legitimate uses listed and counted.
 */
const all = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const isPayment = (name: string) =>
  name === "./api-payments.ts" ||
  name === "./lib/payment-labels.ts" ||
  name.startsWith("./components/payments/") ||
  name === "./pages/PaymentsSettings.tsx";

const files = Object.fromEntries(Object.entries(all).filter(([n]) => isPayment(n)));

const FORBIDDEN: [string, RegExp][] = [
  ["parseFloat", /\bparseFloat\b/g],
  ["parseInt", /\bparseInt\b/g],
  ["Number(...)", /\bNumber\s*\(/g],
  ["Number.parse*", /\bNumber\s*\.\s*parse/g],
  ["toFixed", /\.\s*toFixed\b/g],
  ["toPrecision", /\.\s*toPrecision\b/g],
  ["Math.*", /\bMath\s*\.\s*\w+/g],
  ["unary plus on a value", /(?:^|[=(,:?!&|[{;]|return)\s*\+\s*[a-zA-Z_$(]/gm],
  ["Intl.NumberFormat", /\bIntl\s*\.\s*NumberFormat\b/g],
  ["division of numbers", /[\w)\]]\s*\/\s*(?:100|1000|10)\b(?!n)/g],
];

/** [file, pattern, exact count, why]. Anything else, or one more, fails. */
const ALLOWED: [string, string, number, string][] = [];

/** Blank comments and the text of string literals so only code is scanned. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

describe("payment sources", () => {
  it("finds the files", () => {
    expect(Object.keys(files).length).toBeGreaterThan(8);
    expect(files["./components/payments/PaySheet.tsx"]).toBeTruthy();
    expect(files["./pages/PaymentsSettings.tsx"]).toBeTruthy();
  });

  it("do no float arithmetic", () => {
    const seen: Record<string, number> = {};
    for (const [name, src] of Object.entries(files)) {
      const c = code(src);
      for (const [label, re] of FORBIDDEN) {
        const n = [...c.matchAll(re)].length;
        if (n > 0) seen[`${name} ${label}`] = n;
      }
    }
    const expected: Record<string, number> = {};
    for (const [f, p, n] of ALLOWED) expected[`${f} ${p}`] = n;
    expect(seen).toEqual(expected);
  });

  it("hold no full IBAN literal, no storage, no console output, no raw HTML", () => {
    const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
    for (const [name, src] of Object.entries(files)) {
      expect(IBAN.test(src), name).toBe(false);
      const c = code(src);
      expect(c, name).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/);
      expect(c, name).not.toMatch(/\bconsole\s*\./);
      expect(c, name).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
  });

  it("send the IBAN's last four and fingerprint only: no field named like a full IBAN", () => {
    for (const [name, src] of Object.entries(files)) {
      expect(/\b(?:iban|beneficiaryIban|fullIban)\s*:\s*(?:string|"[A-Z])/.test(src), name).toBe(
        false,
      );
    }
  });

  it("do not name secrets or keys", () => {
    for (const [name, src] of Object.entries(files)) {
      expect(src, name).not.toMatch(/PAYMENTS_IBAN_KEY|client_secret|private_key|Bearer /i);
    }
  });

  it("make the payment calls only from api-payments.ts", () => {
    for (const [name, src] of Object.entries(all)) {
      if (name === "./api-payments.ts") continue;
      expect(/["'`]\/api\/payment(?:s|-batches)\b/.test(src), name).toBe(false);
    }
  });

  it("show no exclamation mark in a sentence the user reads", () => {
    for (const [name, src] of Object.entries(files)) {
      // text between tags and quoted strings that contain a letter before "!" (not "!==", "!x")
      const bad = [...src.matchAll(/[A-Za-z]{2}!(?![=\w])/g)].map((m) => m[0]);
      expect(bad, name).toEqual([]);
    }
  });
});
