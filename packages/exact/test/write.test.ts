import { describe, expect, it } from "vitest";
import {
  ExactApiError,
  ExactAuthError,
  ExactRateLimitedError,
  ExactWriteDisabledError,
  bankEntryIdempotencyKey,
  buildBankEntryPayload,
  buildMatchSetXml,
  createExactWriter,
  exactDuplicateProbeFilter,
  findExistingBankEntryQuery,
  matchSetIdempotencyKey,
  parseBankEntryResponse,
  parseMatchSetResponse,
  sanitizeBankText,
  verifyMatchSetApplied,
  type BankEntryInput,
  type BuiltBankEntry,
  type BuiltMatchSet,
  type ExpectedMatchLine,
  type MatchLineInput,
  type MatchSetInput,
  type OpenItemLineRow,
  ExactWritePayloadError,
  bankLineShortRef,
  xmlEscape,
} from "../src";
import { ok, scripted, status } from "./helpers";

const KEY = bankEntryIdempotencyKey("c1", "tx-1", "leg-1");
const G1 = "11111111-2222-3333-4444-555555555555";
const G2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function entry(over: Partial<BankEntryInput> = {}): BankEntryInput {
  return {
    division: 123,
    journalCode: "90",
    entryDate: "2026-03-05",
    currency: "EUR",
    openingBalanceMinor: 100_000,
    closingBalanceMinor: 112_345,
    idempotencyKey: KEY,
    lines: [
      {
        amountMinor: 12_345,
        description: "Invoice 2026-001 Acme",
        glAccountId: G1,
        accountId: G2,
        ourRef: 2026001,
        bankTransactionExternalId: "tx-1",
      },
    ],
    ...over,
  };
}

function built(over: Partial<BankEntryInput> = {}): BuiltBankEntry {
  const r = buildBankEntryPayload(entry(over));
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("buildBankEntryPayload", () => {
  it("builds the JSON shape with exact decimals and no floats", () => {
    const b = built();
    expect(b.body).toContain('"OpeningBalanceFC":1000.00');
    expect(b.body).toContain('"ClosingBalanceFC":1123.45');
    expect(b.body).toContain('"AmountFC":123.45');
    expect(b.body).toContain('"YourRef":"tx-1"');
    expect(b.body).toContain('"OurRef":2026001');
    const parsed = JSON.parse(b.body) as Record<string, unknown>;
    expect(parsed["Journal"]).toBe("90");
    expect(parsed["BankEntryLines"]).toHaveLength(1);
    // No idempotency header: ExactGate allows only content-type/accept/prefer/if-* headers.
    expect(Object.keys(b.headers).sort()).toEqual(["Accept", "Content-Type"]);
    expect(b.yourRefs).toEqual(["tx-1"]);
    expect(b.division).toBe(123);
    expect(Object.isFrozen(b)).toBe(true);
  });

  it("uses the currency scale: JPY 0 and KWD 3 decimals, negatives", () => {
    const jpy = built({
      currency: "JPY",
      openingBalanceMinor: 0,
      closingBalanceMinor: -1234,
      lines: [
        { amountMinor: -1234, description: "x", glAccountId: G1, bankTransactionExternalId: "t" },
      ],
    });
    expect(jpy.body).toContain('"AmountFC":-1234,');
    const kwd = built({
      currency: "KWD",
      openingBalanceMinor: 5,
      closingBalanceMinor: 1_005,
      lines: [
        { amountMinor: 1_000, description: "x", glAccountId: G1, bankTransactionExternalId: "t" },
      ],
    });
    expect(kwd.body).toContain('"AmountFC":1.000,');
    expect(kwd.body).toContain('"OpeningBalanceFC":0.005');
  });

  it("sends AmountDC only for the division currency, and msdate when asked", () => {
    expect(built().body).not.toContain("AmountDC");
    const b = built({ divisionCurrency: "EUR", dateFormat: "msdate" });
    expect(b.body).toContain('"AmountDC":123.45');
    expect(b.body).toContain('"Date":"/Date(1772668800000)/"');
  });

  it("rejects a balance that does not equal the lines", () => {
    expect(buildBankEntryPayload(entry({ closingBalanceMinor: 112_346 }))).toEqual({
      ok: false,
      error: "balance_mismatch",
    });
  });

  it.each([
    [{ journalCode: "9'0" }, "invalid_journal"],
    [{ currency: "eur" }, "invalid_currency"],
    [{ entryDate: "2026-02-30" }, "invalid_date"],
    [{ entryDate: "05-03-2026" }, "invalid_date"],
    [{ idempotencyKey: "abc" }, "invalid_idempotency_key"],
    [{ openingBalanceMinor: 1.5 }, "invalid_balance"],
    [{ lines: [] }, "no_lines"],
    [{ financialYear: -1 }, "invalid_period"],
    [{ financialYear: 1899 }, "invalid_period"],
    [{ financialPeriod: 0 }, "invalid_period"],
    [{ financialPeriod: 100 }, "invalid_period"],
    [{ division: 0 }, "invalid_division"],
    [{ divisionCurrency: "eur" }, "invalid_currency"],
    [{ currency: "EURO" }, "invalid_currency"],
    [{ closingBalanceMinor: 2 ** 53 }, "invalid_balance"],
  ] as [Partial<BankEntryInput>, string][])("rejects %j", (over, error) => {
    expect(buildBankEntryPayload(entry(over))).toEqual({ ok: false, error });
  });

  it("rejects bad lines", () => {
    const l = entry().lines[0]!;
    const run = (x: Partial<typeof l>, extra?: (typeof l)[]) =>
      buildBankEntryPayload(entry({ lines: [{ ...l, ...x }, ...(extra ?? [])] }));
    expect(run({ amountMinor: 0 })).toMatchObject({ error: "zero_amount_line" });
    expect(run({ amountMinor: 0.5 })).toMatchObject({ error: "invalid_amount" });
    expect(run({ bankTransactionExternalId: "a b" })).toMatchObject({
      error: "invalid_external_id",
    });
    expect(run({ glAccountId: "nope" })).toMatchObject({ error: "invalid_guid" });
    expect(run({ ourRef: -2 })).toMatchObject({ error: "invalid_ref" });
    expect(run({ ourRef: 2 ** 31 })).toMatchObject({ error: "invalid_ref" });
    expect(run({ amountMinor: 2 ** 53 })).toMatchObject({ error: "invalid_amount" });
    expect(run({ glAccountId: undefined, accountId: undefined })).toMatchObject({
      error: "missing_account",
    });
    expect(run({ bankTransactionExternalId: "x".repeat(41) })).toMatchObject({
      error: "external_id_too_long",
    });
    expect(run({ bankTransactionExternalId: "x".repeat(65) })).toMatchObject({
      error: "invalid_external_id",
    });
    // case-insensitive duplicate (Exact's string compare is likely case-insensitive)
    expect(
      buildBankEntryPayload(
        entry({
          closingBalanceMinor: 100_000 + 24_690,
          lines: [l, { ...l, bankTransactionExternalId: "TX-1" }],
        }),
      ),
    ).toMatchObject({ error: "duplicate_external_id" });
    expect(
      buildBankEntryPayload(
        entry({
          closingBalanceMinor: 100_000 + 24_690,
          lines: [l, { ...l }],
        }),
      ),
    ).toMatchObject({ error: "duplicate_external_id" });
  });

  it("falls back to yourRef text, then a fixed text, for the description", () => {
    const l = entry().lines[0]!;
    const a = built({ lines: [{ ...l, description: "", yourRef: "INV 77" }] });
    expect(a.body).toContain("INV 77 #");
    const b = built({ lines: [{ ...l, description: "\u0001\u0002" }] });
    expect(b.body).toContain("Bank line #");
  });

  it("keeps the description within 60 characters including the marker", () => {
    const l = entry().lines[0]!;
    const b = built({ lines: [{ ...l, description: "x".repeat(500) }] });
    const desc = (JSON.parse(b.body) as { BankEntryLines: { Description: string }[] })
      .BankEntryLines[0]!.Description;
    expect(desc.length).toBeLessThanOrEqual(60);
    expect(desc.endsWith(` #${KEY.slice(0, 8)}`)).toBe(true);
  });

  it("never lets an IBAN into the body", () => {
    const l = entry().lines[0]!;
    const b = built({
      lines: [
        {
          ...l,
          description: "Pay NL91 ABNA 0417 1643 00 thanks",
          yourRef: "DE89370400440532013000",
        },
      ],
    });
    expect(b.body).not.toContain("0417");
    expect(b.body).not.toContain("ABNA");
    expect(b.body).toContain("NL91****4300");
  });
});

describe("bank entry: references, sums and JSON safety", () => {
  it("short YourRef mode sends a deterministic short ref and exposes both", () => {
    const ext = "0f7d2c4e-1111-4222-8333-444455556666";
    const l = { ...entry().lines[0]!, bankTransactionExternalId: ext };
    const a = built({ lines: [l], yourRefMode: "short" });
    const short = bankLineShortRef(ext);
    expect(a.yourRefs).toEqual([short]);
    expect(a.lines).toEqual([{ externalId: ext, yourRef: short, shortRef: short }]);
    expect(a.body).toContain(`"YourRef":"${short}"`);
    expect(a.body).not.toContain(ext);
    const b = built({ lines: [l] });
    expect(b.lines).toEqual([{ externalId: ext, yourRef: ext, shortRef: short }]);
    // a long id is allowed in short mode only
    const long = { ...l, bankTransactionExternalId: "x".repeat(50) };
    expect(buildBankEntryPayload(entry({ lines: [long] }))).toMatchObject({
      error: "external_id_too_long",
    });
    expect(buildBankEntryPayload(entry({ lines: [long], yourRefMode: "short" })).ok).toBe(true);
  });

  it("checks the balance equation exactly, beyond float precision", () => {
    const M = Number.MAX_SAFE_INTEGER;
    const l = entry().lines[0]!;
    const lines = [
      { ...l, amountMinor: M, bankTransactionExternalId: "a" },
      { ...l, amountMinor: M, bankTransactionExternalId: "b" },
      { ...l, amountMinor: -M, bankTransactionExternalId: "c" },
      { ...l, amountMinor: -M + 1, bankTransactionExternalId: "d" },
    ];
    // sum is exactly 1
    expect(
      buildBankEntryPayload(entry({ openingBalanceMinor: 0, closingBalanceMinor: 1, lines })).ok,
    ).toBe(true);
    expect(
      buildBankEntryPayload(entry({ openingBalanceMinor: 0, closingBalanceMinor: 2, lines })),
    ).toMatchObject({ error: "balance_mismatch" });
    // closing - opening beyond 2^53 never compares equal by rounding
    expect(
      buildBankEntryPayload(
        entry({
          openingBalanceMinor: -M,
          closingBalanceMinor: M,
          lines: [
            { ...l, amountMinor: M, bankTransactionExternalId: "a" },
            { ...l, amountMinor: M - 1, bankTransactionExternalId: "b" },
          ],
        }),
      ),
    ).toMatchObject({ error: "balance_mismatch" });
    const big = built({
      openingBalanceMinor: 0,
      closingBalanceMinor: M,
      lines: [{ ...l, amountMinor: M }],
    });
    expect(big.body).toContain(`"AmountFC":90071992547409.91`);
  });

  it("never lets hostile text break the JSON", () => {
    const l = entry().lines[0]!;
    const b = built({
      lines: [{ ...l, description: '"},"Journal":"99","x":{"a":"\\\u2028</script>' }],
    });
    const parsed = JSON.parse(b.body) as { Journal: string; BankEntryLines: unknown[] };
    expect(parsed.Journal).toBe("90");
    expect(Object.keys(parsed)).toEqual([
      "Journal",
      "Currency",
      "OpeningBalanceFC",
      "ClosingBalanceFC",
      "BankEntryLines",
    ]);
  });
});

describe("sanitizeBankText", () => {
  it("masks IBANs, strips control characters, folds accents, drops unusual unicode", () => {
    expect(sanitizeBankText("GB82WEST12345698765432 ok")).toBe("GB82****5432 ok");
    expect(sanitizeBankText("a\u0000b\u0007c\td\ne")).toBe("a b c d e");
    expect(sanitizeBankText("Café Zürich €5")).toBe("Cafe Zurich 5");
    expect(sanitizeBankText('<script>"x"</script>')).toBe("script x /script");
    expect(sanitizeBankText("‮😀 hi")).toBe("hi");
    expect(sanitizeBankText("abcdef", 3)).toBe("abc");
    expect(sanitizeBankText("abc", -1)).toBe("");
  });

  it("masks IBANs in every disguise before the cut", () => {
    const leaks = (out: string) => /0417\s?1643|ABNA\s?0417|370400440532/i.test(out);
    for (const text of [
      "NL91ABNA0417164300",
      "nl91 abna 0417 1643 00",
      "NL91-ABNA-0417-1643-00",
      "NL91.ABNA.0417.1643.00",
      "toNL91ABNA0417164300",
      "IBAN:NL91ABNA0417164300",
      "\uFF2E\uFF2C\uFF19\uFF11ABNA0417164300", // full-width "NL91"
      "NL91\u0000ABNA\u00070417\n1643\t00",
      "NL91\u00A0ABNA\u00A00417\u00A01643\u00A000",
      "DE89 3704 0044 0532 0130 00 and more text",
      "DE89370400440532013000",
    ]) {
      const out = sanitizeBankText(text);
      expect(leaks(out), `${JSON.stringify(text)} -> ${out}`).toBe(false);
      for (let max = 1; max <= 40; max++) expect(leaks(sanitizeBankText(text, max))).toBe(false);
    }
    // ordinary references survive
    expect(sanitizeBankText("Invoice 2026-001 Acme")).toBe("Invoice 2026-001 Acme");
  });
});

describe("buildMatchSetXml", () => {
  const L = (o: Partial<MatchLineInput>): MatchLineInput => ({
    currency: "EUR",
    amountMinor: 1,
    ...o,
  });
  const base: MatchSetInput = {
    division: 123,
    glAccountCode: "1300",
    relationCode: "1234",
    currency: "EUR",
    reference: "Match tx-1",
    lines: [
      L({ entryNumber: 20, amountMinor: -12_345 }),
      L({ entryNumber: 5, amountMinor: 12_345 }),
    ],
  };

  it("builds a deterministic document, lines in stable order", () => {
    const a = buildMatchSetXml(base);
    const b = buildMatchSetXml({ ...base, lines: [...base.lines].reverse() });
    expect(a).toEqual(b);
    if (!a.ok) throw new Error(a.error);
    expect(a.division).toBe(123);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(a.xml).not.toMatch(/DOCTYPE|ENTITY/i);
    expect(a.xml.indexOf("<EntryNumber>5<")).toBeLessThan(a.xml.indexOf("<EntryNumber>20<"));
    expect(a.xml).toContain("<Amount>123.45</Amount>");
    expect(a.xml).toContain("<Amount>-123.45</Amount>");
    expect(a.xml).toContain('<GLAccount code="1300"/>');
  });

  it("accepts transaction line ids and scales JPY/KWD", () => {
    const r = buildMatchSetXml({
      ...base,
      currency: "KWD",
      lines: [
        L({ currency: "KWD", transactionLineId: G1.toUpperCase(), amountMinor: 1500 }),
        L({ currency: "KWD", entryNumber: 3, amountMinor: -1500 }),
      ],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.xml).toContain(`<TransactionLineID>${G1}</TransactionLineID>`);
    expect(r.xml).toContain("<Amount>1.500</Amount>");
    const jpy = buildMatchSetXml({
      ...base,
      currency: "JPY",
      lines: base.lines.map((l) => ({ ...l, currency: "JPY" })),
    });
    if (!jpy.ok) throw new Error(jpy.error);
    expect(jpy.xml).toContain("<Amount>12345</Amount>");
  });

  it("refuses non-zero sums as partial matches, with exact BigInt sums and mixed signs", () => {
    expect(
      buildMatchSetXml({
        ...base,
        lines: [base.lines[0]!, L({ entryNumber: 5, amountMinor: 10_000 })],
      }),
    ).toEqual({ ok: false, error: "partial_match_not_supported_v1" });
    // MAX + MAX - MAX - MAX + 1: float sums would lose the 1
    const M = Number.MAX_SAFE_INTEGER;
    expect(
      buildMatchSetXml({
        ...base,
        lines: [
          L({ entryNumber: 1, amountMinor: M }),
          L({ entryNumber: 2, amountMinor: M }),
          L({ entryNumber: 3, amountMinor: -M }),
          L({ entryNumber: 4, amountMinor: -M }),
          L({ entryNumber: 5, amountMinor: 1 }),
        ],
      }),
    ).toEqual({ ok: false, error: "partial_match_not_supported_v1" });
    expect(
      buildMatchSetXml({
        ...base,
        lines: [
          L({ entryNumber: 1, amountMinor: M }),
          L({ entryNumber: 2, amountMinor: M }),
          L({ entryNumber: 3, amountMinor: -M }),
          L({ entryNumber: 4, amountMinor: -M }),
        ],
      }).ok,
    ).toBe(true);
  });

  it.each([
    [{ lines: [L({ entryNumber: 1 })] }, "too_few_lines"],
    [{ division: -1 }, "invalid_division"],
    [{ glAccountCode: "13<00" }, "invalid_gl_account"],
    [{ relationCode: "" }, "invalid_relation"],
    [{ currency: "EU" }, "invalid_currency"],
    [{ reference: " \u0001 " }, "invalid_reference"],
    [{ lines: [L({}), L({ entryNumber: 2, amountMinor: -1 })] }, "invalid_line"],
    [
      {
        lines: [
          L({ entryNumber: 1, transactionLineId: G1 }),
          L({ entryNumber: 2, amountMinor: -1 }),
        ],
      },
      "invalid_line",
    ],
    [{ lines: [L({ entryNumber: 0 }), L({ entryNumber: 2, amountMinor: -1 })] }, "invalid_line"],
    [
      { lines: [L({ entryNumber: 2 ** 31 }), L({ entryNumber: 2, amountMinor: -1 })] },
      "invalid_line",
    ],
    [{ lines: [L({ entryNumber: 1.5 }), L({ entryNumber: 2, amountMinor: -1 })] }, "invalid_line"],
    [
      { lines: [L({ transactionLineId: "x" }), L({ entryNumber: 2, amountMinor: -1 })] },
      "invalid_line",
    ],
    [
      {
        lines: [L({ transactionLineId: `${G1}'/><X a='` }), L({ entryNumber: 2, amountMinor: -1 })],
      },
      "invalid_line",
    ],
    [{ lines: [L({ entryNumber: 1 }), L({ entryNumber: 1, amountMinor: -1 })] }, "duplicate_line"],
    [
      {
        lines: [
          L({ transactionLineId: G1 }),
          L({ transactionLineId: G1.toUpperCase(), amountMinor: -1 }),
        ],
      },
      "duplicate_line",
    ],
    [
      { lines: [L({ entryNumber: 1, amountMinor: 0 }), L({ entryNumber: 2, amountMinor: 0 })] },
      "invalid_amount",
    ],
    [
      {
        lines: [
          L({ entryNumber: 1, amountMinor: 2 ** 53 }),
          L({ entryNumber: 2, amountMinor: -1 }),
        ],
      },
      "invalid_amount",
    ],
    [
      { lines: [L({ entryNumber: 1 }), L({ entryNumber: 2, amountMinor: -1, currency: "USD" })] },
      "mixed_currency",
    ],
  ] as [Partial<MatchSetInput>, string][])("rejects %j", (over, error) => {
    expect(buildMatchSetXml({ ...base, ...over })).toEqual({ ok: false, error });
  });

  it("escapes or refuses injection attempts in every value", () => {
    const r = buildMatchSetXml({ ...base, reference: "a</MatchLine><X/>]]>&\"'" });
    if (!r.ok) throw new Error(r.error);
    expect(r.xml).not.toContain("<X/>");
    expect(r.xml).not.toContain("]]>");
    // reference is sanitised to the conservative set and then escaped
    expect(r.xml).toContain("<Description>a /MatchLine X/ &amp; &apos;</Description>");
    // codes with markup characters are refused outright, never escaped into the document
    expect(buildMatchSetXml({ ...base, relationCode: '1"/><X/>' })).toEqual({
      ok: false,
      error: "invalid_relation",
    });
    expect(buildMatchSetXml({ ...base, glAccountCode: "]]>" })).toEqual({
      ok: false,
      error: "invalid_gl_account",
    });
    // lone surrogates and C0 controls never reach the document
    const s = buildMatchSetXml({ ...base, reference: "ok\uD800\u0000\uFFFE end" });
    if (!s.ok) throw new Error(s.error);
    expect(s.xml).toContain("<Description>ok end</Description>");
  });
});

describe("xmlEscape", () => {
  it("refuses characters XML 1.0 cannot carry, including lone surrogates", () => {
    expect(() => xmlEscape("a\uD800b")).toThrow(RangeError);
    expect(() => xmlEscape("a\uDC00")).toThrow(RangeError);
    expect(() => xmlEscape("\u0001")).toThrow(RangeError);
    expect(xmlEscape("\uD83D\uDE00 <&>\"'")).toBe("\uD83D\uDE00 &lt;&amp;&gt;&quot;&apos;");
  });
});

const SUCCESS =
  '<?xml version="1.0"?><eExact><Messages><Message type="2"><Description>Aangemaakt</Description></Message></Messages></eExact>';

describe("response parsers", () => {
  it("parses a bank entry answer", () => {
    const r = parseBankEntryResponse(
      JSON.stringify({
        d: {
          EntryID: G1.toUpperCase(),
          EntryNumber: 90000012,
          Status: 20,
          BankEntryLines: { results: [{ YourRef: "tx-1" }] },
        },
      }),
      ["tx-1"],
    );
    expect(r).toEqual({
      ok: true,
      entryId: G1,
      entryNumber: 90000012,
      status: "20",
      lineYourRefs: ["tx-1"],
    });
    const s = parseBankEntryResponse(
      `{"d":{"EntryID":"${G1}","EntryNumber":7,"Status":"Open","BankEntryLines":[{"YourRef":"a"}]}}`,
    );
    expect(s).toMatchObject({ ok: true, entryNumber: 7, status: "Open", lineYourRefs: ["a"] });
    // deferred lines (no list in the answer): the refs cannot be checked, still ok
    expect(
      parseBankEntryResponse(
        `{"d":{"EntryID":"${G1}","BankEntryLines":{"__deferred":{"uri":"x"}}}}`,
        ["tx-1"],
      ),
    ).toMatchObject({ ok: true, lineYourRefs: [] });
  });

  it("fails closed on anything unclear, and flags the outcome as unknown", () => {
    const f = (error: string) => ({ ok: false, error, outcomeUnknown: true });
    expect(parseBankEntryResponse("<html>login</html>")).toEqual(f("bad_response"));
    expect(parseBankEntryResponse("")).toEqual(f("bad_response"));
    expect(parseBankEntryResponse("x".repeat(1_000_001))).toEqual(f("bad_response"));
    expect(parseBankEntryResponse('{"error":{"message":"x"}}')).toEqual(f("exact_error"));
    expect(parseBankEntryResponse('{"d":{"EntryID":"nope"}}')).toEqual(f("missing_entry_id"));
    expect(parseBankEntryResponse('{"d":{"EntryNumber":1}}')).toEqual(f("missing_entry_id"));
    expect(parseBankEntryResponse(`{"d":{"EntryID":"${G1}","EntryNumber":"x"}}`)).toEqual(
      f("bad_response"),
    );
    // 2^53 + 1 entry number: raw-number path refuses instead of rounding
    expect(
      parseBankEntryResponse(`{"d":{"EntryID":"${G1}","EntryNumber":9007199254740993}}`),
    ).toEqual(f("bad_response"));
    expect(
      parseBankEntryResponse(
        `{"d":{"EntryID":"${G1}","BankEntryLines":[{"YourRef":"tx-1"},{"YourRef":"tx-9"}]}}`,
        ["tx-1"],
      ),
    ).toEqual(f("line_mismatch"));
  });

  it("accepts a MatchSet answer only with a clear success message, and always wants read-back", () => {
    const r = parseMatchSetResponse(SUCCESS);
    expect(r).toMatchObject({ accepted: true, readBackRequired: true });
    const err = parseMatchSetResponse(SUCCESS.replace('type="2"', 'type="0"'));
    expect(err).toMatchObject({ accepted: false, error: "exact_reported_problem" });
    const warn = parseMatchSetResponse(SUCCESS.replace('type="2"', 'type="1"'));
    expect(warn.accepted).toBe(false);
    const unknown = parseMatchSetResponse(SUCCESS.replace('type="2"', 'type="9"'));
    expect(unknown.accepted).toBe(false);
    const noType = parseMatchSetResponse(SUCCESS.replace(' type="2"', ""));
    expect(noType.accepted).toBe(false);
    expect(parseMatchSetResponse("<eExact></eExact>")).toMatchObject({
      accepted: false,
      error: "no_success_message",
    });
    // one success and one error message: failure
    const mixed = SUCCESS.replace(
      "</Messages>",
      '<Message type="0"><Description>Bad NL91ABNA0417164300</Description></Message></Messages>',
    );
    const m = parseMatchSetResponse(mixed);
    expect(m).toMatchObject({ accepted: false, error: "exact_reported_problem" });
    expect(JSON.stringify(m)).not.toContain("ABNA0417");
  });

  it("refuses HTML pages, empty or huge bodies and DOCTYPE payloads", () => {
    const bad = { accepted: false, error: "bad_xml" };
    expect(parseMatchSetResponse("<html><body>Sign in</body></html>")).toMatchObject(bad);
    expect(parseMatchSetResponse("")).toMatchObject(bad);
    expect(parseMatchSetResponse('<!DOCTYPE x [<!ENTITY a "b">]><eExact/>')).toMatchObject(bad);
    expect(parseMatchSetResponse(`<eExact>${"<!-- x -->".repeat(110_000)}</eExact>`)).toMatchObject(
      bad,
    );
  });
});

describe("verifyMatchSetApplied", () => {
  const row = (o: Partial<OpenItemLineRow>): OpenItemLineRow => ({
    id: G1,
    entryNumber: 5,
    openAmountMinor: 0,
    currency: "EUR",
    isFullyPaid: true,
    ...o,
  });
  const exp: ExpectedMatchLine[] = [
    { entryNumber: 5, currency: "EUR", openBeforeMinor: 12_345 },
    { transactionLineId: G2, currency: "EUR", openBeforeMinor: -12_345 },
  ];
  const closed = [row({}), row({ id: G2.toUpperCase(), entryNumber: 9 })];
  const open = [
    row({ openAmountMinor: 12_345, isFullyPaid: false }),
    row({ id: G2, entryNumber: 9, openAmountMinor: -12_345, isFullyPaid: false }),
  ];

  it("verified only when every line is found once, open 0 and flagged paid", () => {
    expect(verifyMatchSetApplied(closed, exp)).toEqual({ outcome: "verified" });
  });

  it("not_applied only when every line is still open with exactly its amount before", () => {
    expect(verifyMatchSetApplied(open, exp)).toEqual({ outcome: "not_applied" });
  });

  it("an absent row is never decided without the second read", () => {
    expect(verifyMatchSetApplied([closed[1]!], exp)).toEqual({
      outcome: "inconclusive",
      problems: [{ index: 0, reason: "missing_needs_second_query" }],
    });
    // second read (fully paid only) finds it closed: verified
    expect(verifyMatchSetApplied([closed[1]!], exp, [closed[0]!])).toEqual({
      outcome: "verified",
    });
    // second read finds nothing: still inconclusive, never not_applied
    expect(verifyMatchSetApplied([closed[1]!], exp, [])).toEqual({
      outcome: "inconclusive",
      problems: [{ index: 0, reason: "missing" }],
    });
    // second read returns an open row (it asked for paid only): contradiction
    expect(verifyMatchSetApplied([closed[1]!], exp, [open[0]!])).toEqual({
      outcome: "inconclusive",
      problems: [{ index: 0, reason: "contradictory" }],
    });
    expect(verifyMatchSetApplied([closed[1]!], exp, [closed[0]!, closed[0]!])).toEqual({
      outcome: "inconclusive",
      problems: [{ index: 0, reason: "ambiguous" }],
    });
    expect(verifyMatchSetApplied([closed[1]!], exp, [row({ currency: "USD" })])).toEqual({
      outcome: "inconclusive",
      problems: [{ index: 0, reason: "currency_mismatch" }],
    });
  });

  it("truth table of inconclusive cases", () => {
    const inc = (rows: OpenItemLineRow[], e: ExpectedMatchLine[] = exp) =>
      verifyMatchSetApplied(rows, e);
    expect(inc([], [])).toEqual({
      outcome: "inconclusive",
      problems: [{ index: -1, reason: "nothing_expected" }],
    });
    // open amount 0 but not flagged paid, or flagged paid with an amount open
    expect(inc([row({ isFullyPaid: false }), closed[1]!])).toMatchObject({
      outcome: "inconclusive",
      problems: [{ index: 0, reason: "contradictory" }],
    });
    expect(inc([row({ openAmountMinor: 1 }), closed[1]!])).toMatchObject({
      problems: [{ index: 0, reason: "contradictory" }],
    });
    // amount moved (another payment, a part match): not provably either way
    expect(inc([row({ openAmountMinor: 100, isFullyPaid: false }), open[1]!])).toMatchObject({
      problems: [{ index: 0, reason: "unexpected_open_amount" }],
    });
    expect(inc([row({ currency: "USD" }), closed[1]!])).toMatchObject({
      problems: [{ index: 0, reason: "currency_mismatch" }],
    });
    expect(inc([closed[0]!, { ...closed[0]!, id: "x" }, closed[1]!])).toMatchObject({
      problems: [{ index: 0, reason: "ambiguous" }],
    });
    // one closed, one unchanged: partially applied
    expect(inc([closed[0]!, open[1]!])).toEqual({
      outcome: "inconclusive",
      problems: [{ index: -1, reason: "partially_applied" }],
    });
    // an expected line with neither reference can never be found
    expect(inc(closed, [{ currency: "EUR", openBeforeMinor: 1 }])).toMatchObject({
      problems: [{ index: 0, reason: "no_identifier" }],
    });
  });
});

describe("idempotency", () => {
  it("is stable, hex, and sensitive to every input", () => {
    const k = bankEntryIdempotencyKey("c1", "tx-1", "leg-1");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(bankEntryIdempotencyKey("c1", "tx-1", "leg-1")).toBe(k);
    expect(bankEntryIdempotencyKey("c2", "tx-1", "leg-1")).not.toBe(k);
    expect(bankEntryIdempotencyKey("c1", "tx-2", "leg-1")).not.toBe(k);
    expect(bankEntryIdempotencyKey("c1", "tx-1", "leg-2")).not.toBe(k);
    // separator tricks do not collide
    expect(bankEntryIdempotencyKey("c1", "tx-1|leg", "1")).not.toBe(
      bankEntryIdempotencyKey("c1", "tx-1", "leg|1"),
    );
    expect(bankEntryIdempotencyKey("c1", 'tx","1', "x")).not.toBe(
      bankEntryIdempotencyKey("c1", "tx", '1","x'),
    );
    expect(bankEntryIdempotencyKey(1, "t", 2)).toBe(bankEntryIdempotencyKey("1", "t", "2"));
    expect(() => bankEntryIdempotencyKey("", "t", 1)).toThrow(RangeError);
    expect(() => bankEntryIdempotencyKey(1.5, "t", 1)).toThrow(RangeError);
  });

  it("match set key ignores order but not content", () => {
    const k = (tx: string, ids: string[], al: [string, number][]) =>
      matchSetIdempotencyKey(
        tx,
        ids,
        al.map(([itemId, amountMinor]) => ({ itemId, amountMinor })),
      );
    const a = k(
      "t",
      ["i2", "i1"],
      [
        ["i2", 5],
        ["i1", 7],
      ],
    );
    expect(
      k(
        "t",
        ["i1", "i2", "i1"],
        [
          ["i1", 7],
          ["i2", 5],
        ],
      ),
    ).toBe(a);
    expect(
      k(
        "t2",
        ["i1", "i2"],
        [
          ["i1", 7],
          ["i2", 5],
        ],
      ),
    ).not.toBe(a);
    expect(
      k(
        "t",
        ["i1", "i2"],
        [
          ["i1", 8],
          ["i2", 5],
        ],
      ),
    ).not.toBe(a);
    expect(
      k(
        "t",
        ["i1"],
        [
          ["i1", 7],
          ["i1", 2],
        ],
      ),
    ).not.toBe(
      k(
        "t",
        ["i1"],
        [
          ["i1", 2],
          ["i1", 8],
        ],
      ),
    );
    expect(
      k(
        "t",
        ["i1"],
        [
          ["i1", 2],
          ["i1", 1],
        ],
      ),
    ).toBe(
      k(
        "t",
        ["i1"],
        [
          ["i1", 1],
          ["i1", 2],
        ],
      ),
    );
    // NaN and Infinity would both serialise as null: refused
    expect(() => k("t", ["i1"], [["i1", Number.NaN]])).toThrow(RangeError);
    expect(() => k("t", ["i1"], [["i1", Infinity]])).toThrow(RangeError);
    expect(() => k("", ["i1"], [])).toThrow(RangeError);
  });

  it("short refs are deterministic, short and distinct", () => {
    const a = bankLineShortRef("0f7d2c4e-1111-4222-8333-444455556666");
    expect(a).toMatch(/^CT[0-9A-Z]{1,10}$/);
    expect(bankLineShortRef("0f7d2c4e-1111-4222-8333-444455556666")).toBe(a);
    expect(bankLineShortRef("0f7d2c4e-1111-4222-8333-444455556667")).not.toBe(a);
    expect(() => bankLineShortRef("a b")).toThrow(RangeError);
  });

  it("builds the probe filter and refuses hostile input", () => {
    expect(exactDuplicateProbeFilter({ journalCode: "90", yourRef: "tx-1" })).toBe(
      "YourRef eq 'tx-1' and JournalCode eq '90'",
    );
    const q = findExistingBankEntryQuery({ journalCode: "90", yourRef: "tx-1" });
    expect(q.path).toBe("/financialtransaction/BankEntryLines");
    expect(q.query["$select"]).toContain("YourRef");
    for (const yourRef of ["a' or 1 eq 1", "a\u0000", "", "x".repeat(65), "a)", "a%27"]) {
      expect(() => exactDuplicateProbeFilter({ journalCode: "90", yourRef })).toThrow(RangeError);
    }
    expect(() => exactDuplicateProbeFilter({ journalCode: "9'0", yourRef: "a" })).toThrow(
      RangeError,
    );
    expect(() => exactDuplicateProbeFilter({ journalCode: "9\n0", yourRef: "a" })).toThrow(
      RangeError,
    );
  });
});

describe("createExactWriter", () => {
  const opts = { division: 123, jobId: "match", priority: "user" } as const;
  const ms = (over: Partial<MatchSetInput> = {}): BuiltMatchSet => {
    const r = buildMatchSetXml({
      division: 123,
      glAccountCode: "1300",
      relationCode: "1",
      currency: "EUR",
      reference: "r",
      lines: [
        { entryNumber: 1, amountMinor: 5, currency: "EUR" },
        { entryNumber: 2, amountMinor: -5, currency: "EUR" },
      ],
      ...over,
    });
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  it("is disabled unless writeEnabled is exactly true; transport never called", async () => {
    for (const writeEnabled of [
      false,
      "true",
      1,
      {},
      [],
      "yes",
      undefined,
      null,
    ] as unknown as boolean[]) {
      const { transport, calls } = scripted([]);
      const w = createExactWriter(transport, { ...opts, writeEnabled });
      await expect(w.createBankEntry(built())).rejects.toBeInstanceOf(ExactWriteDisabledError);
      await expect(w.submitMatchSet(ms())).rejects.toBeInstanceOf(ExactWriteDisabledError);
      expect(calls).toHaveLength(0);
    }
  });

  it("checks the guard at call time: enabling later never enables, disabling later disables", async () => {
    const off = { ...opts, writeEnabled: false };
    const a = scripted([status(201, `{"d":{"EntryID":"${G1}"}}`)]);
    const w = createExactWriter(a.transport, off);
    off.writeEnabled = true;
    await expect(w.createBankEntry(built())).rejects.toBeInstanceOf(ExactWriteDisabledError);
    await expect(w.submitMatchSet(ms())).rejects.toBeInstanceOf(ExactWriteDisabledError);
    expect(a.calls).toHaveLength(0);

    const on = { ...opts, writeEnabled: true };
    const b = scripted([]);
    const w2 = createExactWriter(b.transport, on);
    on.writeEnabled = false;
    await expect(w2.createBankEntry(built())).rejects.toBeInstanceOf(ExactWriteDisabledError);
    (on as { writeEnabled: unknown }).writeEnabled = "true";
    await expect(w2.submitMatchSet(ms())).rejects.toBeInstanceOf(ExactWriteDisabledError);
    expect(b.calls).toHaveLength(0);
  });

  it("each of the two checks is strict on its own", async () => {
    // "true" (truthy, not true) at creation, true afterwards: still disabled
    let reads = 0;
    const sneaky = {
      ...opts,
      get writeEnabled(): boolean {
        reads++;
        return (reads === 1 ? "true" : true) as unknown as boolean;
      },
    };
    const { transport, calls } = scripted([]);
    const w = createExactWriter(transport, sneaky);
    await expect(w.createBankEntry(built())).rejects.toBeInstanceOf(ExactWriteDisabledError);
    await expect(w.submitMatchSet(ms())).rejects.toBeInstanceOf(ExactWriteDisabledError);
    expect(calls).toHaveLength(0);
  });

  it("snapshots the division: mutating the options cannot redirect a write", async () => {
    const o = { ...opts, writeEnabled: true };
    const { transport, calls } = scripted([status(201, `{"d":{"EntryID":"${G1}"}}`)]);
    const w = createExactWriter(transport, o);
    (o as { division: number }).division = 999;
    await w.createBankEntry(built());
    expect(calls[0]?.division).toBe(123);
  });

  it("sends only branded payloads built for its own division", async () => {
    const { transport, calls } = scripted([]);
    const w = createExactWriter(transport, { ...opts, writeEnabled: true });
    const b = built();
    await expect(w.createBankEntry({ ...b })).rejects.toBeInstanceOf(ExactWritePayloadError);
    await expect(w.createBankEntry(built({ division: 7 }))).rejects.toBeInstanceOf(
      ExactWritePayloadError,
    );
    await expect(
      w.submitMatchSet({ ok: true, division: 123, topic: "MatchSets", xml: "<eExact/>" }),
    ).rejects.toBeInstanceOf(ExactWritePayloadError);
    await expect(w.submitMatchSet(ms({ division: 7 }))).rejects.toBeInstanceOf(
      ExactWritePayloadError,
    );
    // built payloads are frozen: their body cannot be swapped after validation
    expect(() => {
      (b as { body: string }).body = "{}";
    }).toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("validates its options", () => {
    const { transport } = scripted([]);
    expect(() =>
      createExactWriter(transport, { ...opts, writeEnabled: true, division: 0 }),
    ).toThrow(RangeError);
    expect(() => createExactWriter(transport, { ...opts, writeEnabled: true, jobId: "" })).toThrow(
      RangeError,
    );
  });

  it("posts the bank entry once, with only gate-allowed headers", async () => {
    const { transport, calls } = scripted([
      status(201, `{"d":{"EntryID":"${G1}","EntryNumber":4}}`),
    ]);
    const w = createExactWriter(transport, { ...opts, writeEnabled: true });
    const b = built();
    const r = await w.createBankEntry(b);
    expect(r).toMatchObject({ ok: true, entryNumber: 4 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/financialtransaction/BankEntries",
      division: 123,
      priority: "user",
      jobId: "match",
      api: "rest",
      body: b.body,
    });
    for (const h of Object.keys(calls[0]?.headers ?? {}))
      expect(["content-type", "accept"]).toContain(h.toLowerCase());
  });

  it("never retries a POST, whatever the failure, and rethrows transport errors untouched", async () => {
    for (const reply of [status(500, "boom"), status(502), status(503), status(400)]) {
      const { transport, calls } = scripted([reply, reply]);
      const w = createExactWriter(transport, { ...opts, writeEnabled: true });
      await expect(w.createBankEntry(built())).rejects.toBeInstanceOf(ExactApiError);
      await expect(w.submitMatchSet(ms())).rejects.toBeInstanceOf(ExactApiError);
      expect(calls).toHaveLength(2); // one call per method, none repeated
    }
    const boom = new TypeError("network");
    const lost = scripted([boom, boom]);
    const w = createExactWriter(lost.transport, { ...opts, writeEnabled: true });
    await expect(w.createBankEntry(built())).rejects.toBe(boom);
    await expect(w.submitMatchSet(ms())).rejects.toBe(boom);
    expect(lost.calls).toHaveLength(2);
  });

  it("maps 401, 429 and error bodies without leaking IBANs or the request body", async () => {
    const w = (r: ReturnType<typeof status>) =>
      createExactWriter(scripted([r]).transport, { ...opts, writeEnabled: true });
    await expect(w(status(401)).createBankEntry(built())).rejects.toBeInstanceOf(ExactAuthError);
    await expect(
      w(status(429, "", { "retry-after": "7" })).createBankEntry(built()),
    ).rejects.toBeInstanceOf(ExactRateLimitedError);
    const bad = status(400, '{"error":{"message":{"value":"bad NL91ABNA0417164300"}}}');
    const b = built();
    const e = await w(bad)
      .createBankEntry(b)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExactApiError);
    expect((e as Error).message).toContain("NL91****4300");
    expect((e as Error).message).not.toContain("ABNA");
    expect((e as Error).message).not.toContain(b.body);
    expect((e as Error).message).not.toContain("Invoice 2026-001");
    const e2 = await w(status(400, '{"error":{"message":"plain"}}'))
      .createBankEntry(built())
      .catch((x: unknown) => x);
    expect((e2 as Error).message).toContain("plain");
    const e3 = await w(status(500, `<html>${"x".repeat(5000)} DE89370400440532013000</html>`))
      .createBankEntry(built())
      .catch((x: unknown) => x);
    expect((e3 as Error).message.length).toBeLessThan(400);
  });

  it("a 2xx with an unreadable answer is an unknown outcome, never a retry", async () => {
    const { transport, calls } = scripted([ok("<html>login</html>")]);
    const w = createExactWriter(transport, { ...opts, writeEnabled: true });
    expect(await w.createBankEntry(built())).toEqual({
      ok: false,
      error: "bad_response",
      outcomeUnknown: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("submits the MatchSet and never treats acceptance as proof", async () => {
    const { transport, calls } = scripted([ok(SUCCESS)]);
    const w = createExactWriter(transport, { ...opts, writeEnabled: true });
    const m = ms();
    const r = await w.submitMatchSet(m);
    expect(r).toMatchObject({ accepted: true, readBackRequired: true });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/docs/XMLUpload.aspx",
      query: { Topic: "MatchSets" },
      api: "xml",
      division: 123,
      body: m.xml,
    });
  });

  it("probes by YourRef (works without write permission)", async () => {
    const body = JSON.stringify({
      d: { results: [{ ID: G1, EntryID: G2, EntryNumber: 12, YourRef: "tx-1", AmountFC: 10.5 }] },
    });
    const { transport, calls } = scripted([
      ok(body),
      ok('{"d":{"results":[]}}'),
      ok('{"d":[{"YourRef":""}]}'),
    ]);
    const w = createExactWriter(transport, { ...opts, writeEnabled: false });
    const hits = await w.findBankEntryLineByRef({ journalCode: "90", yourRef: "tx-1" });
    expect(hits).toEqual([
      { id: G1, entryId: G2, entryNumber: 12, yourRef: "tx-1", amountFc: "10.5" },
    ]);
    expect(calls[0]).toMatchObject({
      method: "GET",
      query: { $filter: "YourRef eq 'tx-1' and JournalCode eq '90'" },
    });
    expect(await w.findBankEntryLineByRef({ journalCode: "90", yourRef: "tx-2" })).toEqual([]);
    // a hit with unreadable fields still counts as a hit (do not post)
    expect(await w.findBankEntryLineByRef({ journalCode: "90", yourRef: "tx-3" })).toEqual([
      { id: null, entryId: null, entryNumber: null, yourRef: null, amountFc: null },
    ]);
  });

  it("reads open item lines back, and the fully-paid second read", async () => {
    const rows = {
      d: { results: [{ ID: G1, EntryNumber: 5, AmountFC: 0, Currency: "EUR", IsFullyPaid: true }] },
    };
    const { transport, calls } = scripted([
      ok(JSON.stringify(rows)),
      ok(JSON.stringify(rows)),
      ok(JSON.stringify(rows)),
    ]);
    const w = createExactWriter(transport, { ...opts, writeEnabled: false });
    const r = await w.readOpenItemLines({
      kind: "receivable",
      accountId: G2,
      entryNumbers: [5, 6],
    });
    expect(r).toEqual([
      { id: G1, entryNumber: 5, openAmountMinor: 0, currency: "EUR", isFullyPaid: true },
    ]);
    expect(calls[0]?.path).toBe("/cashflow/Receivables");
    expect(calls[0]?.query?.["$filter"]).toBe(
      `Account eq guid'${G2}' and (EntryNumber eq 5 or EntryNumber eq 6)`,
    );
    await w.readOpenItemLines({ kind: "payable", accountId: G2, entryNumbers: [5] });
    expect(calls[1]?.path).toBe("/cashflow/Payables");
    await w.readOpenItemLines({
      kind: "payable",
      accountId: G2,
      entryNumbers: [5],
      fullyPaidOnly: true,
    });
    expect(calls[2]?.query?.["$filter"]).toBe(
      `Account eq guid'${G2}' and (EntryNumber eq 5) and IsFullyPaid eq true`,
    );
    expect(
      verifyMatchSetApplied(r, [{ entryNumber: 5, currency: "EUR", openBeforeMinor: 100 }]),
    ).toEqual({ outcome: "verified" });
  });

  it("refuses bad read-back requests and pages, and bad rows", async () => {
    const w = (replies: ReturnType<typeof ok>[]) =>
      createExactWriter(scripted(replies).transport, { ...opts, writeEnabled: false });
    await expect(
      w([]).readOpenItemLines({ kind: "receivable", accountId: G1, entryNumbers: [] }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      w([]).readOpenItemLines({
        kind: "receivable",
        accountId: G1,
        entryNumbers: Array.from({ length: 21 }, (_, i) => i + 1),
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      w([]).readOpenItemLines({ kind: "receivable", accountId: G1, entryNumbers: [0] }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      w([]).readOpenItemLines({ kind: "receivable", accountId: "x", entryNumbers: [1] }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      w([ok('{"d":{"results":[],"__next":"https://x/y"}}')]).readOpenItemLines({
        kind: "payable",
        accountId: G1,
        entryNumbers: [1],
      }),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    await expect(
      w([ok('{"d":{"results":[{"ID":"a","Currency":"EUR"}]}}')]).readOpenItemLines({
        kind: "payable",
        accountId: G1,
        entryNumbers: [1],
      }),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    await expect(
      w([ok('{"d":{"results":[{"Currency":"EUR","AmountFC":1}]}}')]).readOpenItemLines({
        kind: "payable",
        accountId: G1,
        entryNumbers: [1],
      }),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
    await expect(
      w([ok('{"d":{"x":1}}')]).findBankEntryLineByRef({ journalCode: "90", yourRef: "t" }),
    ).rejects.toMatchObject({ code: "BAD_SHAPE" });
  });
});
