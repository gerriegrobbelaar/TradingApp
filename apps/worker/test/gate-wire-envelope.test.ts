/**
 * G9 follow-ups (ADR 0048): the two gates answer with the same wire envelope, and there is one job
 * id pattern. `exact/wire.ts` and `revolut/wire.ts` stay two files (each rebuilds its own typed
 * errors), so this test PINS that they stay identical in shape and behaviour.
 */
import { JOB_ID_RE } from "@camelthorn/core";
import {
  ExactApiError,
  ExactAuthError,
  ExactBudgetExhaustedError,
  ExactRateLimitedError,
  ExactWriteAuthRetryRefused,
} from "@camelthorn/exact";
import {
  RevolutApiError,
  RevolutAuthError,
  RevolutBudgetExhaustedError,
  RevolutRateLimitedError,
  RevolutWriteAuthRetryRefused,
} from "@camelthorn/revolut";
import { describe, expect, it } from "vitest";
import * as exactWire from "../src/exact/wire";
import * as revolutWire from "../src/revolut/wire";

const src = (
  import.meta as unknown as { glob: (p: string[], o: object) => Record<string, string> }
).glob(["../src/**/*.ts", "../../../packages/*/src/**/*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("one job id pattern", () => {
  it("is defined exactly once (packages/core/src/job-id.ts)", () => {
    const defs = Object.entries(src)
      .filter(([, raw]) => /JOB_ID_RE\s*=\s*\//.test(raw))
      .map(([f]) => f);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatch(/packages\/core\/src\/job-id\.ts$/);
    expect(JOB_ID_RE.test("revolut-payment:reconcile")).toBe(true);
    expect(JOB_ID_RE.test("bad id")).toBe(false);
    expect(JOB_ID_RE.test("x".repeat(101))).toBe(false);
  });
});

describe("the wire envelopes of both gates are identical", () => {
  const pairs: [string, unknown, unknown][] = [
    ["rate limited", new ExactRateLimitedError(1234), new RevolutRateLimitedError(1234)],
    ["budget", new ExactBudgetExhaustedError("job-1"), new RevolutBudgetExhaustedError("job-1")],
    ["auth", new ExactAuthError("needs_reauth"), new RevolutAuthError("needs_reauth")],
    ["write auth refused", new ExactWriteAuthRetryRefused(), new RevolutWriteAuthRetryRefused()],
    ["api with code", new ExactApiError(409, "x", "c"), new RevolutApiError(409, "x", "c")],
    ["api without code", new ExactApiError(500, "x"), new RevolutApiError(500, "x")],
    ["unknown error", new Error("secret detail"), new Error("secret detail")],
  ];
  for (const [name, e, r] of pairs) {
    it(`encodes ${name} the same way`, () => {
      expect(revolutWire.toWire(r)).toEqual(exactWire.toWire(e));
    });
  }

  it("an unknown failure is gate_unavailable (outcome unknown); a refused write has its own kind", () => {
    expect(revolutWire.toWire(new Error("x"))).toEqual({
      kind: "api",
      status: 503,
      code: "gate_unavailable",
    });
    expect(revolutWire.toWire(new RevolutWriteAuthRetryRefused())).toEqual({
      kind: "write_auth_retry_refused",
    });
  });

  it("rebuilds the typed refusal on the other side, still a RevolutApiError (503)", () => {
    const e = revolutWire.fromWire({ kind: "write_auth_retry_refused" });
    expect(e).toBeInstanceOf(RevolutWriteAuthRetryRefused);
    expect(e).toBeInstanceOf(RevolutApiError);
    expect(e).toMatchObject({ status: 503, code: "write_auth_retry_refused" });
    // and a plain gate_unavailable is NOT that type
    const g = revolutWire.fromWire({ kind: "api", status: 503, code: "gate_unavailable" });
    expect(g).not.toBeInstanceOf(RevolutWriteAuthRetryRefused);
  });

  it("the two wire files differ only in the provider's names", () => {
    const norm = (raw: string, provider: "Exact" | "Revolut") =>
      raw
        .replace(new RegExp(provider, "g"), "P")
        .replace(new RegExp(provider.toLowerCase(), "g"), "p")
        .replace(/\s+/g, " ");
    const body = (raw: string) => raw.slice(raw.indexOf("export type WireError"));
    const e = Object.entries(src).find(([f]) => f.endsWith("src/exact/wire.ts"))?.[1] ?? "";
    const r = Object.entries(src).find(([f]) => f.endsWith("src/revolut/wire.ts"))?.[1] ?? "";
    expect(e.length).toBeGreaterThan(100);
    expect(norm(body(r), "Revolut")).toBe(norm(body(e), "Exact"));
  });
});
