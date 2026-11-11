/**
 * ExactGate hardening for the write path (task M7c, ADR 0044): the gate refuses every non-GET
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
  // The gate checks EVERY precondition: the Revolut connection must have decided who books lines.
  await db
    .prepare(
      `INSERT INTO connections (kind, name, status, creates_bank_entries, bank_entries_decided_at)
       VALUES ('revolut', 'revolut', 'active', 1, '2026-07-01T00:00:00.000Z')`,
    )
    .run();
  stub = stubExact();
});
afterEach(() => {
  stub.restore();
});

const ENTRY_BODY =
  '{"Journal":"90","Currency":"EUR","OpeningBalanceFC":0.00,"ClosingBalanceFC":1.00,"BankEntryLines":[{"Account":"11111111-2222-3333-4444-555555555555","AmountFC":1.00,"Date":"2026-07-15","Description":"x","YourRef":"t1"}]}';
const MATCHSET_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n<eExact xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="eExact-XML.xsd"><MatchSets><MatchSet><GLAccount code="1300"/><Account code="R1"/><Currency code="EUR"/><Description>M</Description><MatchLines><MatchLine><EntryNumber>1</EntryNumber><Amount>1.00</Amount></MatchLine><MatchLine><EntryNumber>2</EntryNumber><Amount>-1.00</Amount></MatchLine></MatchLines></MatchSet></MatchSets></eExact>';

const bankEntry = (over: Partial<ExactRequest> = {}): Partial<ExactRequest> => ({
  method: "POST",
  path: "/financialtransaction/BankEntries",
  priority: "job",
  jobId: BOOKING_JOB_ID,
  body: ENTRY_BODY,
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
  body: MATCHSET_BODY,
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
    // query tricks
    ["topic in lower case", matchSet({ query: { Topic: "matchsets" } })],
    ["topic key in lower case", matchSet({ query: { topic: "MatchSets" } })],
    ["two topic keys", matchSet({ query: { Topic: "MatchSets", topic: "Accounts" } })],
    ["a second topic inside the value", matchSet({ query: { Topic: "MatchSets&Topic=Accounts" } })],
    ["an encoded second topic", matchSet({ query: { Topic: "MatchSets%26Topic%3DAccounts" } })],
    ["a topic with a trailing space", matchSet({ query: { Topic: "MatchSets " } })],
    // path tricks
    [
      "dot-dot after the resource",
      bankEntry({ path: "/financialtransaction/BankEntries/../../crm/Accounts" }),
    ],
    ["a trailing slash", bankEntry({ path: "/financialtransaction/BankEntries/" })],
    ["a double slash", bankEntry({ path: "//financialtransaction/BankEntries" })],
    ["an encoded slash", bankEntry({ path: "/financialtransaction%2FBankEntries" })],
    ["the resource in lower case", bankEntry({ path: "/financialtransaction/bankentries" })],
    [
      "a keyed bank entry (an update target)",
      bankEntry({
        path: "/financialtransaction/BankEntries(guid'11111111-2222-3333-4444-555555555555')",
      }),
    ],
    ["a query in the path", bankEntry({ path: "/financialtransaction/BankEntries?x=1" })],
    ["the XML endpoint with a trailing slash", matchSet({ path: "/docs/XMLUpload.aspx/" })],
    ["the XML endpoint in lower case", matchSet({ path: "/docs/xmlupload.aspx" })],
    // method tricks
    ["PATCH", bankEntry({ method: "PATCH" as ExactRequest["method"] })],
    ["a method override header", bankEntry({ headers: { "X-HTTP-Method-Override": "DELETE" } })],
    ["an X-HTTP-Method header", matchSet({ headers: { "X-HTTP-Method": "PUT" } })],
    // body tricks
    [
      "another topic smuggled in the MatchSets document",
      matchSet({
        body: '<?xml version="1.0" encoding="utf-8"?>\n<eExact><Accounts><Account code="1"/></Accounts></eExact>',
      }),
    ],
    [
      "a second topic after the MatchSets",
      matchSet({ body: MATCHSET_BODY.replace("</MatchSets>", "</MatchSets><GLTransactions/>") }),
    ],
    [
      "a DOCTYPE (entity tricks)",
      matchSet({
        body: MATCHSET_BODY.replace("\n<eExact", '\n<!DOCTYPE x [<!ENTITY a "b">]><eExact'),
      }),
    ],
    ["a CDATA section", matchSet({ body: MATCHSET_BODY.replace(">M<", "><![CDATA[M]]><") })],
    [
      "something other than MatchSet inside MatchSets",
      matchSet({ body: MATCHSET_BODY.replace("<MatchSets>", "<MatchSets><Journal/>") }),
    ],
    ["a JSON array body", bankEntry({ body: "[]" })],
    [
      "a bank entry with an unknown field",
      bankEntry({ body: ENTRY_BODY.replace('{"Journal"', '{"Type":40,"Journal"') }),
    ],
    [
      "a bank entry line with an unknown field",
      bankEntry({ body: ENTRY_BODY.replace('"YourRef"', '"VATCode":"1","YourRef"') }),
    ],
    ["a bank entry without lines", bankEntry({ body: '{"Journal":"90","BankEntryLines":[]}' })],
    ["a body that is not JSON", bankEntry({ body: "Journal=90" })],
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

describe("every precondition, checked by the gate itself", () => {
  it("refuses while the Revolut connection has not decided who creates the bank entries", async () => {
    const div = freshDivision();
    await setBooking(true, true);
    await db
      .prepare("UPDATE connections SET bank_entries_decided_at = NULL WHERE kind = 'revolut'")
      .run();
    expect(await call(div, bankEntry())).toEqual({
      ok: false,
      error: { kind: "api", status: 403, code: "writes_disabled" },
    });
    expect(posts()).toBe(0);
  });

  it("re-checks right before the network call: a switch-off during the token refresh stops the POST", async () => {
    await resetExact();
    await db
      .prepare(
        `INSERT INTO connections (kind, name, status, creates_bank_entries, bank_entries_decided_at)
         VALUES ('revolut', 'revolut', 'active', 1, '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    // An access token about to expire: the gate refreshes it before the call.
    await seedConnection({ expiresInMs: 30_000 });
    const div = freshDivision();
    await setBooking(true, true);
    const ok = stub.token;
    stub.token = async (f, n) => {
      await setBooking(false, true); // switched off while the request is at the token step
      return ok(f, n);
    };
    const r = await call(div, bankEntry());
    expect(r).toEqual({ ok: false, error: { kind: "api", status: 403, code: "writes_disabled" } });
    expect(stub.tokenCalls.length).toBe(1);
    expect(posts()).toBe(0);
  });

  it("a GET that carries a body is sent as a plain GET without it", async () => {
    const div = freshDivision();
    const r = await call(div, {
      method: "GET",
      path: "/financialtransaction/BankEntries",
      body: ENTRY_BODY,
    });
    expect(r.ok).toBe(true);
    expect(stub.apiCalls).toHaveLength(1);
    expect(stub.apiCalls[0]).toMatchObject({ method: "GET", body: undefined });
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
