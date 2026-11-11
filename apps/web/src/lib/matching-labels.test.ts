/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { BLOCK_CODES, REASON_CODES, explainBlock } from "@camelthorn/core";
import { ApiError, StepUpRequired } from "../api";
import {
  BLOCK_LABELS,
  BOOKING_STATUS,
  BOOKING_STATUS_ORDER,
  ERROR_TEXT,
  REASON_LABELS,
  REVIEW_REASON_LABELS,
  blockLabel,
  blockLabels,
  blockerText,
  bookingSentence,
  describeMatchError,
  exactStateLabel,
  isStale,
} from "./matching-labels";

const worker = import.meta.glob("../../../worker/src/matching/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("labels cover every code", () => {
  it("has a label for every block code in core (and the worker's own)", () => {
    expect(BLOCK_CODES.length).toBeGreaterThanOrEqual(19);
    for (const code of [...BLOCK_CODES, "incomplete_input"]) {
      expect(BLOCK_LABELS[code], code).toBeTruthy();
    }
    // and nothing is labelled that core does not know (a stale label is a lie)
    for (const code of Object.keys(BLOCK_LABELS)) {
      expect([...BLOCK_CODES, "incomplete_input"], code).toContain(code);
    }
  });

  it("names the block codes the engine source really uses", () => {
    const engine = Object.entries(
      import.meta.glob("../../../../packages/core/src/matching/engine.ts", {
        query: "?raw",
        import: "default",
        eager: true,
      }) as Record<string, string>,
    )[0]?.[1];
    expect(engine).toBeTruthy();
    const used = new Set<string>();
    for (const m of (engine ?? "").matchAll(/["'`]([a-z]+(?:_[a-z]+)+)["'`]/g)) {
      if ((BLOCK_CODES as readonly string[]).includes(m[1] as string)) used.add(m[1] as string);
    }
    // every code the engine can push has a label; guard against an engine code that is not in BLOCKS
    for (const m of (engine ?? "").matchAll(/blocked\.push\(\s*"([a-z_]+)"/g)) {
      expect(BLOCK_LABELS[m[1] as string], m[1]).toBeTruthy();
    }
    for (const m of (engine ?? "").matchAll(/out\.push\(\s*"([a-z_]+)"/g)) {
      expect(BLOCK_LABELS[m[1] as string], m[1]).toBeTruthy();
    }
    expect(used.size).toBeGreaterThan(5);
  });

  it("has a label for every reason code", () => {
    for (const code of REASON_CODES) expect(REASON_LABELS[code], code).toBeTruthy();
    expect(Object.keys(REASON_LABELS).sort()).toEqual([...REASON_CODES].sort());
  });

  it("explains an unknown code calmly and never shows the raw code", () => {
    expect(blockLabel("brand_new_code")).toBe("A person needs to check this");
    expect(blockLabel("__proto__")).toBe("A person needs to check this");
    expect(blockLabel("constructor")).toBe("A person needs to check this");
  });

  it("lists each reason once", () => {
    expect(
      blockLabels([
        { code: "tx_frozen", text: "a" },
        { code: "tx_frozen", text: "b" },
        { code: "item_closed", text: "c" },
      ]),
    ).toEqual([BLOCK_LABELS["tx_frozen"], BLOCK_LABELS["item_closed"]]);
  });

  it("every label is sentence case, calm and has no code in it", () => {
    const all = [
      ...Object.values(BLOCK_LABELS),
      ...Object.values(REASON_LABELS),
      ...Object.values(ERROR_TEXT),
      ...Object.values(REVIEW_REASON_LABELS),
      ...BOOKING_STATUS_ORDER.flatMap((s) => [BOOKING_STATUS[s].label, BOOKING_STATUS[s].hint]),
    ];
    for (const t of all) {
      expect(t, t).toMatch(/^[A-Z]/);
      expect(t, t).not.toContain("!");
      expect(t, t).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it("the plain labels agree in meaning with core's own sentences (same code set)", () => {
    for (const code of BLOCK_CODES) expect(explainBlock(code)).toContain("goes to review");
  });
});

describe("server refusals in plain words", () => {
  const codes = new Set<string>();
  it("finds the codes of the matching routes", () => {
    const routes = Object.entries(worker).find(([n]) => n.endsWith("/routes.ts"))?.[1] ?? "";
    expect(routes.length).toBeGreaterThan(1000);
    for (const m of routes.matchAll(/ApiError\(\s*"([a-z_]+)"/g)) codes.add(m[1] as string);
    for (const m of routes.matchAll(/\["([a-z_]+)",\s*(?:409|422)\]/g)) codes.add(m[1] as string);
    for (const m of routes.matchAll(/BadRequest\(\s*"([a-z_]+)"/g)) codes.add(m[1] as string);
    expect(codes.size).toBeGreaterThan(30);
  });

  it("every code the routes send has a sentence (bad_* share one)", () => {
    for (const code of codes) {
      const text = describeMatchError(new ApiError(code.startsWith("bad_") ? 400 : 409, code));
      expect(text, code).toMatch(/^[A-Z]/);
      expect(text, code).not.toContain(code);
      if (!code.startsWith("bad_")) expect(ERROR_TEXT[code], code).toBeTruthy();
    }
  });

  it("maps the codes the brief names", () => {
    const say = (status: number, code: string) => describeMatchError(new ApiError(status, code));
    expect(say(409, "item_has_live_match")).toMatch(/already uses this invoice/);
    expect(say(422, "allocation_exceeds_open")).toMatch(/more than what is still open/);
    expect(say(422, "allocation_sum_mismatch")).toMatch(/add up to the bank line/);
    expect(say(409, "tx_state_conflict")).toMatch(/administrator must check/);
    expect(say(422, "division_inactive")).toMatch(/not being synced/);
    expect(say(422, "currency_mismatch")).toMatch(/currency/);
    expect(say(409, "already_booked_in_exact")).toBe("Already booked in Exact. Reverse it there.");
    expect(say(409, "different_relation")).toMatch(/different customer or supplier/);
    expect(say(409, "anything_else")).toMatch(/changed in the meantime/);
    expect(say(500, "boom")).toMatch(/Nothing was changed/);
    expect(say(403, "forbidden")).toMatch(/permission/);
    expect(describeMatchError(new TypeError("network"))).toMatch(/Could not reach the server/);
  });

  it("never echoes a server message", () => {
    const e = new ApiError(409, "weird", undefined, "secret NL91ABNA0417164300 detail");
    expect(describeMatchError(e)).not.toMatch(/secret|NL91/);
  });

  it("only moved data is a reason to refresh", () => {
    expect(isStale(new ApiError(409, "x"))).toBe(true);
    expect(isStale(new ApiError(422, "x"))).toBe(true);
    expect(isStale(new ApiError(404, "not_found"))).toBe(true);
    expect(isStale(new ApiError(500, "x"))).toBe(false);
    expect(isStale(new StepUpRequired())).toBe(false);
    expect(isStale(new TypeError("x"))).toBe(false);
  });
});

describe("booking wording", () => {
  it("says what happens in Exact for each setting", () => {
    expect(bookingSentence({ enabled: false, blockers: [] })).toBe(
      "This is recorded in the app only; nothing is booked in Exact yet.",
    );
    expect(bookingSentence({ enabled: true, blockers: [] })).toBe(
      "Booking in Exact happens automatically afterwards and cannot be undone here.",
    );
    expect(bookingSentence({ enabled: true, blockers: ["not_verified"] })).toMatch(/blocked/);
    expect(bookingSentence(null)).toMatch(/depends on a setting/);
  });

  it("turns blockers into sentences", () => {
    expect(blockerText("not_verified")).toMatch(/not been verified/);
    expect(blockerText("some_new_thing")).toBe("Some new thing.");
    expect(blockerText("")).toBe("Something blocks booking.");
  });

  it("labels every status and the Exact state", () => {
    expect(BOOKING_STATUS_ORDER).toHaveLength(10);
    for (const s of BOOKING_STATUS_ORDER) expect(BOOKING_STATUS[s].label).toBeTruthy();
    expect(exactStateLabel("not_booked")).toBe("Not booked in Exact");
    expect(exactStateLabel("mystery")).toBe("Handled in Exact");
  });
});
