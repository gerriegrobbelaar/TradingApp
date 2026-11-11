/**
 * ExactGate hardening for the write path (task M7c, ADR 0043): the gate refuses every non-GET
 * request except the two booking writes, and those only for job `exact-booking` at priority `job`
 * while the gate itself (re-reading D1 at call time) finds the fail-closed switch on and the
 * verification mark current. POSTs are never retried or redirected, and count against the budget.
 */
import {
  ExactBudgetExhaustedError,
  ExactWriteAuthRetryRefused,
  type ExactRequest,
} from "@camelthorn/exact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateName } from "../src/exact/gate-transport";
import { allowedWriteShape, BOOKING_JOB_ID } from "../src/exact/write-policy";
import { unwrap } from "../src/exact/wire";
import { setBooking } from "./booking-helpers";
import {
  db,
  freshDivision,
  gateStub,
  req,
  resetExact,
  seedConnection,
  stubExact,
  type ExactStub,
} from "./exact-helpers";

let stub: ExactStub;
beforeEach(async () => {
  await resetExact();
  await db.prepare("DELETE FROM settings WHERE key LIKE 'exact.booking_%'").run();
  await seedConnection();
  stub = stubExact();
});
afterEach(() => {
  stub.restore();
});

const bankEntry = (over: Partial<ExactRequest> = {}): Partial<ExactRequest> => ({
  method: "POST",
  path: "/financialtransaction/BankEntries",
  priority: "job",
  jobId: BOOKING_JOB_ID,
  body: '{"Journal":"90"}',
  headers: { "Content-Type": "application/json" },
  ...over,
});
const matchSet = (over: Partial<ExactRequest> = {}): Partial<ExactRequest> => ({
  method: "POST",
  api: "xml",
  path: "/docs/XMLUpload.aspx",
  query: { Topic: "MatchSets" },
  priority: "job",
  jobId: BOOKING_JOB_ID,
  body: "<eExact/>",
  headers: { "Content-Type": "text/xml" },
  ...over,
});

const call = async (div: number, over: Partial<ExactRequest>) =>
  gateStub(gateName(div)).call(req(div, over));
const posts = (): number => stub.apiCalls.filter((c) => c.method !== "GET").length;

describe("fail closed at the gate", () => {
  it("refuses both booking writes while the switch is off or nothing was verified", async () => {
    const div = freshDivision();
    for (const over of [bankEntry(), matchSet()]) {
      const r = await call(div, over);
      expect(r).toEqual({
        ok: false,
        error: { kind: "api", status: 403, code: "writes_disabled" },
      });
    }
    await setBooking(true, false); // on, but never verified
    expect((await call(div, bankEntry())).ok).toBe(false);
    await setBooking(false, true); // verified, but off
    expect((await call(div, matchSet())).ok).toBe(false);
    await setBooking(true, "e".repeat(64)); // verified an older protocol
    expect((await call(div, bankEntry())).ok).toBe(false);
    expect(posts()).toBe(0);
  });

  it("lets the two booking writes through once the switch is on and the verification is current", async () => {
    const div = freshDivision();
    await setBooking(true, true);
    const a = await call(div, bankEntry());
    const b = await call(div, matchSet());
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(stub.apiCalls.map((c) => [c.method, c.url.pathname])).toEqual([
      ["POST", `/api/v1/${div}/financialtransaction/BankEntries`],
      ["POST", "/docs/XMLUpload.aspx"],
    ]);
    expect(stub.apiCalls[1]?.url.searchParams.get("Topic")).toBe("MatchSets");
  });

  it("reads the switch again at every call: it is never cached", async () => {
    const div = freshDivision();
    await setBooking(true, true);
    expect((await call(div, bankEntry())).ok).toBe(true);
    await setBooking(false, true);
    expect((await call(div, bankEntry())).ok).toBe(false);
    await setBooking(true, true);
    expect((await call(div, bankEntry())).ok).toBe(true);
    expect(posts()).toBe(2);
  });
});

describe("everything else is refused, even with booking on", () => {
  beforeEach(async () => {
    await setBooking(true, true);
  });

  const refused: [string, Partial<ExactRequest>][] = [
    ["POST to another REST resource", bankEntry({ path: "/crm/Accounts" })],
    ["POST to the bank entry lines", bankEntry({ path: "/financialtransaction/BankEntryLines" })],
    ["POST to a journal entry", bankEntry({ path: "/financialtransaction/GeneralJournalEntries" })],
    ["PUT to the bank entries", bankEntry({ method: "PUT" })],
    [
      "DELETE of a bank entry",
      bankEntry({ method: "DELETE", path: "/financialtransaction/BankEntries" }),
    ],
    ["a different XML topic", matchSet({ query: { Topic: "Accounts" } })],
    [
      "XML upload with an extra query parameter",
      matchSet({ query: { Topic: "MatchSets", Extra: "1" } }),
    ],
    ["XML upload without a topic", matchSet({ query: {} })],
    ["POST to XMLDownload", matchSet({ path: "/docs/XMLDownload.aspx" })],
    ["a GET of the XML upload endpoint", matchSet({ method: "GET", body: undefined })],
    ["another job id", bankEntry({ jobId: "exact-booking-2" })],
    ["the sync job id", bankEntry({ jobId: "sync:full:5:r1" })],
    ["priority user", bankEntry({ priority: "user" })],
    ["a bank entry without a body", bankEntry({ body: "" })],
    ["a bank entry with a query", bankEntry({ query: { x: "1" } })],
    ["XML upload for MatchSets as REST", matchSet({ api: "rest", path: "/docs/XMLUpload.aspx" })],
  ];
  it.each(refused)("%s", async (_name, over) => {
    const div = freshDivision();
    const r = await call(div, over);
    expect(r.ok).toBe(false);
    expect(posts()).toBe(0);
  });

  it("a write on division 0 (current) never gets through", async () => {
    const r = await call(0, bankEntry({ division: 0 }));
    expect(r.ok).toBe(false);
    expect(posts()).toBe(0);
  });

  it("the shape check itself says no to all of them", () => {
    for (const [, over] of refused) {
      // some of these are refused by the generic validation first; the shape check must never accept
      expect(allowedWriteShape(req(1, over))).toBe(false);
    }
    expect(allowedWriteShape(req(1, bankEntry()))).toBe(true);
    expect(allowedWriteShape(req(1, matchSet()))).toBe(true);
  });
});

describe("posts are never retried, followed or hidden from the budget", () => {
  it("a POST that gets 401 is not re-sent after the refresh: ExactWriteAuthRetryRefused", async () => {
    const div = freshDivision();
    await setBooking(true, true);
    stub.api = () => new Response("nope", { status: 401 });
    const r = await call(div, bankEntry());
    expect(r).toEqual({ ok: false, error: { kind: "write_auth_retry_refused" } });
    expect(() => unwrap(r)).toThrow(ExactWriteAuthRetryRefused);
    expect(posts()).toBe(1);
    // A later call (after the refresh) works again with the new token.
    stub.api = () => Response.json({ d: {} });
    expect((await call(div, bankEntry())).ok).toBe(true);
    expect(posts()).toBe(2);
  });

  it("a GET that gets 401 is still retried once (reads are safe to repeat)", async () => {
    const div = freshDivision();
    let n = 0;
    stub.api = () =>
      ++n === 1 ? new Response("nope", { status: 401 }) : Response.json({ d: { results: [] } });
    const r = await call(div, { method: "GET", path: "/crm/Accounts" });
    expect(r.ok).toBe(true);
    expect(stub.apiCalls).toHaveLength(2);
  });

  it("a 429 and a 500 on a POST are returned once, not retried", async () => {
    const div = freshDivision();
    await setBooking(true, true);
    stub.api = () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
    expect((await call(div, bankEntry())).ok).toBe(false);
    expect(posts()).toBe(1);
    stub.api = () => new Response("boom", { status: 500 });
    const r = await call(div, bankEntry());
    expect(r.ok && r.response.status).toBe(500);
    expect(posts()).toBe(2);
  });

  it("a redirect is never followed (the answer is returned as it is)", async () => {
    const div = freshDivision();
    await setBooking(true, true);
    stub.api = () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
    const r = await call(div, bankEntry());
    expect(r.ok && r.response.status).toBe(302);
    expect(stub.apiCalls).toHaveLength(1);
  });

  it("writes count against the job budget like any call", async () => {
    const div = freshDivision();
    await setBooking(true, true);
    const gate = gateStub(gateName(div));
    await gate.startJob(BOOKING_JOB_ID, 2);
    expect((await call(div, bankEntry())).ok).toBe(true);
    expect((await call(div, matchSet())).ok).toBe(true);
    const third = await call(div, bankEntry());
    expect(third).toEqual({ ok: false, error: { kind: "budget", jobId: BOOKING_JOB_ID } });
    expect(() => unwrap(third)).toThrow(ExactBudgetExhaustedError);
    expect(posts()).toBe(2);
    expect((await gate.endJob(BOOKING_JOB_ID)).used).toBe(2);
  });
});
