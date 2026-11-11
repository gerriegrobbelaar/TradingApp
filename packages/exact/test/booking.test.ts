import { describe, expect, it } from "vitest";
import {
  BANK_ENTRY_SIGN,
  BOOKING_PROTOCOL_VERSION,
  EXACT_WRITE_NAMES,
  WRITE_BUILDER_RULES,
  bookingProtocolCanonical,
  computeBookingProtocolVersion,
  createExactWriter,
  findBankLineByAmountQuery,
  latestBankEntryQuery,
  parseLatestClosingBalance,
} from "../src";
import { ExactWriteAuthRetryRefused } from "../src";
import { ok, scripted } from "./helpers";

describe("BOOKING_PROTOCOL_VERSION", () => {
  it("is a sha-256 computed from the code, the same every time", () => {
    expect(BOOKING_PROTOCOL_VERSION).toMatch(/^[0-9a-f]{64}$/);
    expect(computeBookingProtocolVersion()).toBe(BOOKING_PROTOCOL_VERSION);
  });

  it("changes when ANY name, the sign convention or a builder rule changes", () => {
    const mutable = EXACT_WRITE_NAMES as unknown as {
      rest: { bankEntryPath: string; line: { yourRef: string } };
      xml: { topic: string };
    };
    const rules = WRITE_BUILDER_RULES as unknown as { descriptionMax: number; matchSet: string };
    const sign = BANK_ENTRY_SIGN as unknown as string;
    const base = computeBookingProtocolVersion();
    const attempts: [string, () => () => void][] = [
      [
        "bank entry path",
        () => {
          const was = mutable.rest.bankEntryPath;
          mutable.rest.bankEntryPath = "/bookkeeping/BankEntries";
          return () => (mutable.rest.bankEntryPath = was);
        },
      ],
      [
        "a field name",
        () => {
          const was = mutable.rest.line.yourRef;
          mutable.rest.line.yourRef = "YourReference";
          return () => (mutable.rest.line.yourRef = was);
        },
      ],
      [
        "the XML topic",
        () => {
          const was = mutable.xml.topic;
          mutable.xml.topic = "MatchSetsX";
          return () => (mutable.xml.topic = was);
        },
      ],
      [
        "a builder rule string",
        () => {
          const was = rules.matchSet;
          rules.matchSet = "matchset/v2";
          return () => (rules.matchSet = was);
        },
      ],
      [
        "the description cap",
        () => {
          const was = rules.descriptionMax;
          rules.descriptionMax = 61;
          return () => (rules.descriptionMax = was);
        },
      ],
    ];
    const seen = new Set<string>([base]);
    for (const [name, change] of attempts) {
      const restore = change();
      try {
        const v = computeBookingProtocolVersion();
        expect(v, name).not.toBe(base);
        seen.add(v);
      } finally {
        restore();
      }
    }
    expect(seen.size).toBe(attempts.length + 1);
    expect(computeBookingProtocolVersion()).toBe(base);
    expect(sign).toBe("money_in_positive");
  });

  it("covers the helpers that decide what and whether we send (sanitiser, escaping, money, probes, parsers, read-back)", () => {
    const c = bookingProtocolCanonical();
    // IBAN masking on adversarial input (glued, lower case, punctuated, full-width digits)
    expect(c).toContain('"NL91****4300"');
    expect(c).not.toMatch(/NL91ABNA0417164300|0417 1643/);
    // the probe filters: a wrong filter turns "already in Exact" into "not found"
    expect(c).toContain("YourRef eq 'tx-1' and JournalCode eq '90'");
    expect(c).toContain("AmountFC eq -123.45");
    expect(c).toContain("EntryNumber desc");
    // money at scales 0, 2 and 3, and the refusal above 2^53
    for (const v of ['"-0.005"', '"1.234"', '"90071992547409.91"', '"invalid_balance"']) {
      expect(c).toContain(v);
    }
    // XML escaping and its refusals, the MatchSet structure, read-back verdicts
    expect(c).toContain("&lt;a href=&apos;x&apos;&gt;&amp;&quot;]]&gt;");
    expect(c).toContain("<MatchSets><MatchSet><GLAccount code=");
    expect(c).toContain('"not_applied"');
    expect(c).toContain('"missing_needs_second_query"');
  });

  it("is pinned: a deliberate change of what we send must update this value AND re-verify on a test division", () => {
    expect(BOOKING_PROTOCOL_VERSION).toBe(PINNED);
  });
});

const PINNED = "d1721e6fcac05ccb0b97adff63315b7d74364f0b60b33ce4cab9cb26fcb02a50";

describe("probe and balance queries", () => {
  it("builds the amount probe with a date window, quoted journal and exact decimal", () => {
    const q = findBankLineByAmountQuery({
      journalCode: "90",
      amountMinor: -12_345,
      currency: "EUR",
      dateFrom: "2026-07-14",
      dateTo: "2026-07-18",
    });
    expect(q.path).toBe("/financialtransaction/BankEntryLines");
    expect(q.query["$filter"]).toBe(
      "JournalCode eq '90' and AmountFC eq -123.45 and Date ge datetime'2026-07-14T00:00:00' and Date le datetime'2026-07-18T23:59:59'",
    );
    expect(q.query["$top"]).toBe("5");
  });

  it.each([
    [
      {
        journalCode: "90'; drop",
        amountMinor: 1,
        currency: "EUR",
        dateFrom: "2026-07-14",
        dateTo: "2026-07-15",
      },
    ],
    [
      {
        journalCode: "90",
        amountMinor: 0,
        currency: "EUR",
        dateFrom: "2026-07-14",
        dateTo: "2026-07-15",
      },
    ],
    [
      {
        journalCode: "90",
        amountMinor: 1.5,
        currency: "EUR",
        dateFrom: "2026-07-14",
        dateTo: "2026-07-15",
      },
    ],
    [
      {
        journalCode: "90",
        amountMinor: 1,
        currency: "eur",
        dateFrom: "2026-07-14",
        dateTo: "2026-07-15",
      },
    ],
    [
      {
        journalCode: "90",
        amountMinor: 1,
        currency: "EUR",
        dateFrom: "2026-07-16",
        dateTo: "2026-07-15",
      },
    ],
    [
      {
        journalCode: "90",
        amountMinor: 1,
        currency: "EUR",
        dateFrom: "2026-02-30",
        dateTo: "2026-03-01",
      },
    ],
  ])("refuses a bad probe %#", (args) => {
    expect(() => findBankLineByAmountQuery(args)).toThrow(RangeError);
  });

  it("asks for the latest entry of the journal", () => {
    const q = latestBankEntryQuery("90");
    expect(q.path).toBe("/financialtransaction/BankEntries");
    expect(q.query).toMatchObject({ $orderby: "EntryNumber desc", $top: "1" });
    expect(() => latestBankEntryQuery("x y;")).toThrow(RangeError);
  });

  it("reads the closing balance only when it is clearly one entry in the right currency", () => {
    const row = { Currency: "EUR", ClosingBalanceFC: "1234.56", EntryNumber: "5" };
    expect(parseLatestClosingBalance([row], "EUR")).toBe(123_456);
    expect(parseLatestClosingBalance([], "EUR")).toBeNull();
    expect(parseLatestClosingBalance([row, row], "EUR")).toBeNull();
    expect(parseLatestClosingBalance([{ ...row, Currency: "USD" }], "EUR")).toBeNull();
    expect(parseLatestClosingBalance([{ ...row, ClosingBalanceFC: "x" }], "EUR")).toBeNull();
    expect(parseLatestClosingBalance([{ ...row, ClosingBalanceFC: null }], "EUR")).toBeNull();
  });
});

describe("writer reads for the booker", () => {
  const writer = (replies: Parameters<typeof scripted>[0]) => {
    const s = scripted(replies);
    return {
      calls: s.calls,
      w: createExactWriter(s.transport, {
        writeEnabled: false,
        division: 5,
        jobId: "exact-booking",
        priority: "job",
      }),
    };
  };

  it("reads the closing balance and the amount probe without the write switch (they are GETs)", async () => {
    const { w, calls } = writer([
      ok('{"d":{"results":[{"Currency":"EUR","ClosingBalanceFC":100.5,"EntryNumber":7}]}}'),
      ok('{"d":{"results":[{"EntryNumber":9,"YourRef":"abc","AmountFC":12.34}]}}'),
    ]);
    expect(await w.readLatestClosingBalance({ journalCode: "90", currency: "EUR" })).toBe(10_050);
    const hits = await w.findBankLineByAmount({
      journalCode: "90",
      amountMinor: 1_234,
      currency: "EUR",
      dateFrom: "2026-07-14",
      dateTo: "2026-07-15",
    });
    expect(hits).toEqual([
      { id: null, entryId: null, entryNumber: 9, yourRef: "abc", amountFc: "12.34" },
    ]);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(calls.every((c) => c.jobId === "exact-booking" && c.priority === "job")).toBe(true);
  });

  it("a paged probe answer is never 'exactly one' or 'none': an extra unreadable hit is added", async () => {
    const { w } = writer([
      ok(
        '{"d":{"results":[{"EntryNumber":9,"YourRef":"tx-1","AmountFC":1}],"__next":"https://x/next"}}',
      ),
      ok('{"d":{"results":[],"__next":"https://x/next"}}'),
    ]);
    const a = await w.findBankEntryLineByRef({ journalCode: "90", yourRef: "tx-1" });
    expect(a).toHaveLength(2);
    expect(a[1]).toEqual({
      id: null,
      entryId: null,
      entryNumber: null,
      yourRef: null,
      amountFc: null,
    });
    const b = await w.findBankLineByAmount({
      journalCode: "90",
      amountMinor: 100,
      currency: "EUR",
      dateFrom: "2026-07-14",
      dateTo: "2026-07-15",
    });
    expect(b).toHaveLength(1);
  });

  it("passes the gate's typed 401 refusal through untouched (the booker re-probes)", async () => {
    const { w } = writer([new ExactWriteAuthRetryRefused()]);
    await expect(
      w.readLatestClosingBalance({ journalCode: "90", currency: "EUR" }),
    ).rejects.toBeInstanceOf(ExactWriteAuthRetryRefused);
  });
});
