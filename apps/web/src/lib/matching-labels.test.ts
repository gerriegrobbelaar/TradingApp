/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { BLOCK_CODES, BOOKING_VERIFY_CHECKS, REASON_CODES, explainBlock } from "@camelthorn/core";
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
  BLOCKER_FALLBACK,
  BOOKING_BLOCKERS,
  BOOKING_DEFERRAL_CODES,
  DEFERRAL_FALLBACK,
  DEFERRAL_TEXT,
  VERIFY_CHECK_TEXT,
  PREVIEW_READ_ERROR_TEXT,
  RUN_BLOCKERS,
  isRunBlocker,
  previewOutcomeReason,
  previewReadErrorText,
  deferralReason,
  deferredChipText,
  verifyCheckLabel,
  NO_PAYMENT,
  blockerText,
  bookingSentence,
  bookingState,
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
      // Every code has its OWN sentence, bad_* included (review M7d): a new code fails here.
      expect(Object.prototype.hasOwnProperty.call(ERROR_TEXT, code), code).toBe(true);
    }
  });

  it("finds the codes added by review M7d in the worker source (the scan is not empty-handed)", () => {
    for (const c of ["bad_ids", "item_changed", "allocation_exceeds_open", "has_live_matches"]) {
      expect(codes, c).toContain(c);
    }
  });

  it("maps the codes the brief names", () => {
    const say = (status: number, code: string) => describeMatchError(new ApiError(status, code));
    expect(say(409, "item_has_live_match")).toMatch(/already uses this invoice/);
    expect(say(422, "allocation_exceeds_open")).toMatch(/more than what is still free/);
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
  const off = { enabled: false, blockers: [] as string[] };
  const ready = { enabled: true, blockers: [] as string[] };
  const blocked = { enabled: true, blockers: ["not_verified"] };
  const protocol = { enabled: true, blockers: [] as string[], protocolChanged: true };
  const offButBlocked = { enabled: false, blockers: ["writes_disabled"] };

  it("keys the state off enabled + blockers (matrix)", () => {
    expect(bookingState(null)).toBe("unknown");
    expect(bookingState(off)).toBe("off");
    expect(bookingState(offButBlocked)).toBe("off");
    expect(bookingState(ready)).toBe("ready");
    expect(bookingState(blocked)).toBe("blocked");
    expect(bookingState(protocol)).toBe("blocked");
  });

  it("only the ready state promises booking now; every state says no money moves", () => {
    expect(bookingSentence(ready)).toBe(
      "This is recorded in the app, then booked in Exact automatically afterwards and cannot be undone here. No money is paid or moved.",
    );
    expect(bookingSentence(off)).toBe(
      "This is recorded in the app only. Nothing is booked in Exact, because booking in Exact is off. No money is paid or moved.",
    );
    expect(bookingSentence(offButBlocked)).toBe(bookingSentence(off));
    expect(bookingSentence(blocked)).toMatch(/on but blocked right now, so nothing is booked yet/);
    expect(bookingSentence(protocol)).toBe(bookingSentence(blocked));
    expect(bookingSentence(null)).toMatch(/could not be read/);
    for (const s of [null, off, ready, blocked, protocol]) {
      expect(bookingSentence(s)).toContain(NO_PAYMENT);
      expect(bookingSentence(s)).not.toMatch(/\bpaid\b(?! or moved)/);
    }
    for (const s of [null, off, blocked]) {
      expect(bookingSentence(s)).not.toMatch(/^This is recorded in the app, then booked/);
    }
  });

  it("labels exactly the fixed blocker codes, and never echoes an unknown one", () => {
    expect([...BOOKING_BLOCKERS].sort()).toEqual(
      [
        "bank_entries_undecided",
        "control_accounts_missing",
        "journal_unmapped",
        "mode_changed",
        "no_division_allowed",
        "no_exact_connection",
        "not_verified",
        "protocol_changed",
        "writes_disabled",
      ].sort(),
    );
    const texts = BOOKING_BLOCKERS.map(blockerText);
    expect(new Set(texts).size).toBe(BOOKING_BLOCKERS.length);
    for (const t of texts) {
      expect(t).not.toBe(BLOCKER_FALLBACK);
      expect(t).toMatch(/^[A-Z].*\.$/);
      expect(t).not.toMatch(/[a-z]+_[a-z]+/);
    }
    for (const odd of ["some_new_thing", "", "__proto__", "NL91ABNA0417164300", "<b>x</b>"]) {
      expect(blockerText(odd)).toBe(BLOCKER_FALLBACK);
    }
  });

  it("labels every status and the Exact state", () => {
    expect(BOOKING_STATUS_ORDER).toHaveLength(10);
    for (const s of BOOKING_STATUS_ORDER) expect(BOOKING_STATUS[s].label).toBeTruthy();
    expect(exactStateLabel("not_booked")).toBe("Not booked in Exact");
    expect(exactStateLabel("mystery")).toBe("Handled in Exact");
  });
});

const workerBooking = import.meta.glob("../../../worker/src/booking/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const src = (name: string): string =>
  Object.entries(workerBooking).find(([n]) => n.endsWith(`/${name}`))?.[1] ?? "";

describe("booking deferral reasons (a deferred match is calm, never an error)", () => {
  it("labels every code the worker defers a match with (plan.ts, the fee and mode checks)", () => {
    const plan = src("plan.ts");
    expect(plan.length).toBeGreaterThan(1000);
    const block = /DEFER_PLAN_CODES[^=]*=\s*\[([^\]]*)\]/.exec(plan)?.[1] ?? "";
    const codes = [...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThanOrEqual(6);
    codes.push(/FEE_DEFER_CODE\s*=\s*"([a-z0-9_]+)"/.exec(plan)?.[1] ?? "missing_fee_code");
    for (const m of plan.matchAll(/return "([a-z0-9_]+)";/g)) codes.push(m[1] as string); // modeDeferral
    expect(codes).toContain("mode_mismatch");
    // the executor's own literal deferrals
    for (const m of src("executor.ts").matchAll(/defer\(cand, "([a-z0-9_]+)"\)/g))
      codes.push(m[1] as string);
    for (const code of codes) {
      expect(deferralReason(code), code).not.toBe(DEFERRAL_FALLBACK);
      const chip = deferredChipText(code);
      expect(chip, code).toMatch(/^Cannot be booked yet: [a-zA-Z]/);
      expect(chip, code).not.toMatch(/[a-z]+_[a-z]+/);
      expect(chip, code).not.toContain("!");
    }
    // and nothing is labelled that the worker never sends (a stale label is a lie)
    for (const code of BOOKING_DEFERRAL_CODES) expect(codes, code).toContain(code);
    expect(Object.keys(DEFERRAL_TEXT).sort()).toEqual([...BOOKING_DEFERRAL_CODES].sort());
    expect(new Set(BOOKING_DEFERRAL_CODES.map(deferralReason)).size).toBe(
      BOOKING_DEFERRAL_CODES.length,
    );
  });

  it("a build_<error> deferral has one sentence; an unknown code a fixed fallback, never echoed", () => {
    expect(deferralReason("build_bad_amount")).toBe("the request to Exact could not be built");
    for (const odd of [
      "brand_new",
      "",
      "__proto__",
      "constructor",
      "NL91ABNA0417164300",
      "build_",
    ]) {
      expect(deferralReason(odd)).toBe(DEFERRAL_FALLBACK);
      expect(deferredChipText(odd)).toBe(`Cannot be booked yet: ${DEFERRAL_FALLBACK}`);
    }
  });

  it("the preview explains every outcome code the worker can send (preview.ts, plan.ts)", () => {
    const preview = src("preview.ts");
    const plan = src("plan.ts");
    expect(preview.length).toBeGreaterThan(1000);
    const codes = new Set<string>();
    for (const m of plan.matchAll(/fail\("([a-z0-9_]+)"\)/g)) codes.add(m[1] as string);
    for (const m of preview.matchAll(/return "([a-z0-9_]+)";/g)) codes.add(m[1] as string);
    for (const m of preview.matchAll(/empty\(matchId, "([a-z0-9_]+)"\)/g))
      codes.add(m[1] as string);
    for (const m of preview.matchAll(/wouldDefer \?\? "([a-z0-9_]+)"/g)) codes.add(m[1] as string);
    for (const m of preview.matchAll(/wouldDefer \?\?= "([a-z0-9_]+)"/g)) codes.add(m[1] as string);
    for (const v of ["already_settled", "changed", "inconclusive"]) codes.add(`preflight_${v}`);
    expect(codes.size).toBeGreaterThan(20);
    const readErrors = new Set<string>();
    for (const m of preview.matchAll(/readError(?: \?\?)?= "([a-z0-9_]+)"/g))
      readErrors.add(m[1] as string);
    const fn = /function readErrorCode[\s\S]*?\n\}/.exec(preview)?.[0] ?? "";
    for (const m of fn.matchAll(/return "([a-z0-9_]+)"/g)) readErrors.add(m[1] as string);
    expect(readErrors.size).toBeGreaterThanOrEqual(5);
    for (const c of readErrors) {
      expect(Object.keys(PREVIEW_READ_ERROR_TEXT), `read error ${c}`).toContain(c);
    }
    for (const c of codes) {
      if (readErrors.has(c)) continue;
      const t = previewOutcomeReason(c);
      expect(t, c).not.toBe(DEFERRAL_FALLBACK);
      expect(t, c).not.toMatch(/[a-z]+_[a-z]+/);
    }
    expect(previewReadErrorText("weird_code")).toBe("a read from Exact failed");
  });
});

describe("booking blockers match the worker", () => {
  it("lists exactly the worker's blocker codes and its run blockers", () => {
    const settings = src("settings.ts");
    const type = /export type BookingBlocker =([^;]*);/.exec(settings)?.[1] ?? "";
    const all = [...type.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(all.length).toBeGreaterThanOrEqual(9);
    expect([...BOOKING_BLOCKERS].sort()).toEqual([...all].sort());
    const run = /RUN_BLOCKERS[^=]*=\s*\[([^\]]*)\]/.exec(settings)?.[1] ?? "";
    const runCodes = [...run.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...RUN_BLOCKERS].sort()).toEqual(runCodes.sort());
    for (const b of all) expect(isRunBlocker(b), b).toBe(runCodes.includes(b));
    expect(isRunBlocker("unknown_future_blocker")).toBe(true);
  });
});

describe("booking route refusals in plain words", () => {
  it("every code booking/*.ts sends has its own sentence", () => {
    const codes = new Set<string>();
    for (const [name, text] of Object.entries(workerBooking)) {
      if (name.endsWith(".test.ts")) continue;
      for (const m of text.matchAll(/ApiError\(\s*"([a-z_]+)"/g)) codes.add(m[1] as string);
      for (const m of text.matchAll(/note\([^)]*"([a-z_]+)"\)/g)) codes.add(m[1] as string);
      for (const m of text.matchAll(/error: "([a-z_]+)"/g)) codes.add(m[1] as string);
    }
    expect(codes.size).toBeGreaterThan(15);
    for (const c of ["checks_incomplete", "blocked", "bad_note", "step_up_required", "in_flight"]) {
      expect(codes, c).toContain(c);
    }
    for (const code of codes) {
      expect(Object.prototype.hasOwnProperty.call(ERROR_TEXT, code), code).toBe(true);
      const text = describeMatchError(new ApiError(409, code));
      expect(text, code).toMatch(/^[A-Z]/);
      expect(text, code).not.toContain(code);
    }
  });
});

describe("verification checks (one instruction per core code)", () => {
  it("has a label and an instruction for every check in core, and nothing else", () => {
    expect(Object.keys(VERIFY_CHECK_TEXT).sort()).toEqual([...BOOKING_VERIFY_CHECKS].sort());
    for (const c of BOOKING_VERIFY_CHECKS) {
      const t = VERIFY_CHECK_TEXT[c];
      expect(t.label, c).toMatch(/^[A-Z]/);
      expect(t.how, c).toMatch(/^[A-Z].*\.$/);
      expect(t.label + t.how, c).not.toMatch(/[a-z]+_[a-z]+/);
      expect(t.label + t.how, c).not.toContain("!");
      expect(verifyCheckLabel(c)).toBe(t.label);
    }
  });

  it("docs/DEPLOY.md step 0 item 18 names every check code, its label and its reference", () => {
    const deploy =
      Object.values(
        import.meta.glob("../../../../docs/DEPLOY.md", {
          query: "?raw",
          import: "default",
          eager: true,
        }) as Record<string, string>,
      )[0] ?? "";
    const start = deploy.indexOf("18. **Booking: verify the write path");
    expect(start).toBeGreaterThan(0);
    const end = deploy.indexOf("\n### ", start);
    const item = deploy.slice(start, end).replace(/\s+/g, " ");
    for (const c of BOOKING_VERIFY_CHECKS) {
      const t = VERIFY_CHECK_TEXT[c];
      expect(item, c).toContain(`\`${c}\``);
      expect(item, `${c} label`).toContain(`"${t.label}"`);
      expect(item, `${c} reference`).toContain(t.doc);
    }
    // the placeholder number the dialog names is the one the runbook names
    expect(item).toContain("999999999");
  });

  it("an unknown recorded check gets one calm sentence", () => {
    expect(verifyCheckLabel("future_check")).toBe("A check this version does not know");
    expect(verifyCheckLabel("__proto__")).toBe("A check this version does not know");
  });

  it("the checks error has a sentence", () => {
    expect(describeMatchError(new ApiError(400, "checks_incomplete"))).toMatch(/Tick every check/);
  });
});
