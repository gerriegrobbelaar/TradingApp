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
  type MatchSetInput,
  type OpenItemLineRow,
} from "../src";
import { ok, scripted, status } from "./helpers";

const KEY = bankEntryIdempotencyKey("c1", "tx-1", "leg-1");
const G1 = "11111111-2222-3333-4444-555555555555";
const G2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function entry(over: Partial<BankEntryInput> = {}): BankEntryInput {
  return {
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
    expect(b.headers["X-Idempotency-Key"]).toBe(KEY);
    expect(b.yourRefs).toEqual(["tx-1"]);
  });

  it("uses the currency scale: JPY 0 and KWD 3 decimals, negatives", () => {
    const jpy = built({
      currency: "JPY",
      openingBalanceMinor: 0,
      closingBalanceMinor: -1234,
      lines: [{ amountMinor: -1234, description: "x", bankTransactionExternalId: "t" }],
    });
    expect(jpy.body).toContain('"AmountFC":-1234,');
    const kwd = built({
      currency: "KWD",
      openingBalanceMinor: 5,
      closingBalanceMinor: 1_005,
      lines: [{ amountMinor: 1_000, description: "x", bankTransactionExternalId: "t" }],
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
});

describe("buildMatchSetXml", () => {
  const base: MatchSetInput = {
    glAccountCode: "1300",
    relationCode: "1234",
    currency: "EUR",
    reference: "Match tx-1",
    lines: [
      { entryNumber: 20, amountMinor: -12_345 },
      { entryNumber: 5, amountMinor: 12_345 },
    ],
  };

  it("builds a deterministic document, lines in stable order", () => {
    const a = buildMatchSetXml(base);
    const b = buildMatchSetXml({ ...base, lines: [...base.lines].reverse() });
    expect(a).toEqual(b);
    if (!a.ok) throw new Error(a.error);
    expect(a.xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(a.xml).not.toMatch(/DOCTYPE/i);
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
        { transactionLineId: G1.toUpperCase(), amountMinor: 1500 },
        { entryNumber: 3, amountMinor: -1500 },
      ],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.xml).toContain(`<TransactionLineID>${G1}</TransactionLineID>`);
    expect(r.xml).toContain("<Amount>1.500</Amount>");
    const jpy = buildMatchSetXml({ ...base, currency: "JPY" });
    if (!jpy.ok) throw new Error(jpy.error);
    expect(jpy.xml).toContain("<Amount>12345</Amount>");
  });

  it("refuses non-zero sums as partial matches", () => {
    expect(
      buildMatchSetXml({
        ...base,
        lines: [base.lines[0]!, { entryNumber: 5, amountMinor: 10_000 }],
      }),
    ).toEqual({ ok: false, error: "partial_match_not_supported_v1" });
  });

  it.each([
    [{ lines: [base.lines[0]!] }, "too_few_lines"],
    [{ glAccountCode: "13<00" }, "invalid_gl_account"],
    [{ relationCode: "" }, "invalid_relation"],
    [{ currency: "EU" }, "invalid_currency"],
    [{ reference: " \u0001 " }, "invalid_reference"],
    [{ lines: [{ amountMinor: 1 }, { entryNumber: 2, amountMinor: -1 }] }, "invalid_line"],
    [
      {
        lines: [
          { entryNumber: 1, transactionLineId: G1, amountMinor: 1 },
          { entryNumber: 2, amountMinor: -1 },
        ],
      },
      "invalid_line",
    ],
    [
      {
        lines: [
          { entryNumber: 0, amountMinor: 1 },
          { entryNumber: 2, amountMinor: -1 },
        ],
      },
      "invalid_line",
    ],
    [
      {
        lines: [
          { transactionLineId: "x", amountMinor: 1 },
          { entryNumber: 2, amountMinor: -1 },
        ],
      },
      "invalid_line",
    ],
    [
      {
        lines: [
          { entryNumber: 1, amountMinor: 1 },
          { entryNumber: 1, amountMinor: -1 },
        ],
      },
      "duplicate_line",
    ],
    [
      {
        lines: [
          { entryNumber: 1, amountMinor: 0 },
          { entryNumber: 2, amountMinor: 0 },
        ],
      },
      "invalid_amount",
    ],
    [
      {
        lines: [
          { entryNumber: 1, amountMinor: Number.MAX_SAFE_INTEGER },
          { entryNumber: 2, amountMinor: Number.MAX_SAFE_INTEGER },
        ],
      },
      "invalid_amount",
    ],
  ] as [Partial<MatchSetInput>, string][])("rejects %j", (over, error) => {
    expect(buildMatchSetXml({ ...base, ...over })).toEqual({ ok: false, error });
  });

  it("escapes injection attempts in every value", () => {
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
  });

  it("fails closed on anything unclear", () => {
    expect(parseBankEntryResponse("<html>login</html>")).toEqual({
      ok: false,
      error: "bad_response",
    });
    expect(parseBankEntryResponse('{"error":{"message":"x"}}')).toEqual({
      ok: false,
      error: "exact_error",
    });
    expect(parseBankEntryResponse('{"d":{"EntryID":"nope"}}')).toEqual({
      ok: false,
      error: "missing_entry_id",
    });
    expect(parseBankEntryResponse('{"d":{"EntryNumber":1}}')).toEqual({
      ok: false,
      error: "missing_entry_id",
    });
    expect(parseBankEntryResponse(`{"d":{"EntryID":"${G1}","EntryNumber":"x"}}`)).toEqual({
      ok: false,
      error: "bad_response",
    });
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
    expect(parseMatchSetResponse("<eExact></eExact>")).toMatchObject({
      accepted: false,
      error: "no_success_message",
    });
  });

  it("refuses HTML pages and DOCTYPE payloads", () => {
    expect(parseMatchSetResponse("<html><body>Sign in</body></html>")).toMatchObject({
      accepted: false,
      error: "bad_xml",
    });
    expect(parseMatchSetResponse('<!DOCTYPE x [<!ENTITY a "b">]><eExact/>')).toMatchObject({
      accepted: false,
      error: "bad_xml",
    });
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
  const exp = [
    { entryNumber: 5, currency: "EUR" },
    { transactionLineId: G2, currency: "EUR" },
  ];
  const rows = [row({}), row({ id: G2.toUpperCase(), entryNumber: 9 })];

  it("verifies only when every line is found once with nothing open", () => {
    expect(verifyMatchSetApplied(rows, exp)).toEqual({ verified: true });
  });

  it("truth table of failures", () => {
    expect(verifyMatchSetApplied([], [])).toMatchObject({ verified: false });
    expect(verifyMatchSetApplied([rows[0]!], exp)).toEqual({
      verified: false,
      problems: [{ index: 1, reason: "missing" }],
    });
    expect(
      verifyMatchSetApplied([row({ openAmountMinor: 100, isFullyPaid: false }), rows[1]!], exp),
    ).toEqual({
      verified: false,
      problems: [{ index: 0, reason: "still_open" }],
    });
    // flagged paid but amount open: not trusted
    expect(verifyMatchSetApplied([row({ openAmountMinor: 1 }), rows[1]!], exp)).toMatchObject({
      verified: false,
    });
    expect(verifyMatchSetApplied([row({ currency: "USD" }), rows[1]!], exp)).toEqual({
      verified: false,
      problems: [{ index: 0, reason: "currency_mismatch" }],
    });
    expect(verifyMatchSetApplied([rows[0]!, { ...rows[0]!, id: "x" }, rows[1]!], exp)).toEqual({
      verified: false,
      problems: [{ index: 0, reason: "ambiguous" }],
    });
    // an expected line with neither reference can never be found
    expect(verifyMatchSetApplied(rows, [{ currency: "EUR" }])).toMatchObject({ verified: false });
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
    expect(bankEntryIdempotencyKey(1, "t", 2)).toBe(bankEntryIdempotencyKey("1", "t", "2"));
  });

  it("match set key ignores order but not content", () => {
    const a = matchSetIdempotencyKey(
      "t",
      ["i2", "i1"],
      [
        { itemId: "i2", amountMinor: 5 },
        { itemId: "i1", amountMinor: 7 },
      ],
    );
    const b = matchSetIdempotencyKey(
      "t",
      ["i1", "i2", "i1"],
      [
        { itemId: "i1", amountMinor: 7 },
        { itemId: "i2", amountMinor: 5 },
      ],
    );
    expect(a).toBe(b);
    expect(
      matchSetIdempotencyKey(
        "t2",
        ["i1", "i2"],
        [
          { itemId: "i1", amountMinor: 7 },
          { itemId: "i2", amountMinor: 5 },
        ],
      ),
    ).not.toBe(a);
    expect(
      matchSetIdempotencyKey(
        "t",
        ["i1", "i2"],
        [
          { itemId: "i1", amountMinor: 8 },
          { itemId: "i2", amountMinor: 5 },
        ],
      ),
    ).not.toBe(a);
    expect(
      matchSetIdempotencyKey(
        "t",
        ["i1"],
        [
          { itemId: "i1", amountMinor: 7 },
          { itemId: "i1", amountMinor: 2 },
        ],
      ),
    ).not.toBe(
      matchSetIdempotencyKey(
        "t",
        ["i1"],
        [
          { itemId: "i1", amountMinor: 2 },
          { itemId: "i1", amountMinor: 8 },
        ],
      ),
    );
    expect(
      matchSetIdempotencyKey(
        "t",
        ["i1"],
        [
          { itemId: "i1", amountMinor: 2 },
          { itemId: "i1", amountMinor: 1 },
        ],
      ),
    ).toBe(
      matchSetIdempotencyKey(
        "t",
        ["i1"],
        [
          { itemId: "i1", amountMinor: 1 },
          { itemId: "i1", amountMinor: 2 },
        ],
      ),
    );
  });

  it("builds the probe filter and refuses hostile input", () => {
    expect(exactDuplicateProbeFilter({ journalCode: "90", yourRef: "tx-1" })).toBe(
      "YourRef eq 'tx-1' and JournalCode eq '90'",
    );
    const q = findExistingBankEntryQuery({ journalCode: "90", yourRef: "tx-1" });
    expect(q.path).toBe("/financialtransaction/BankEntryLines");
    expect(q.query["$select"]).toContain("YourRef");
    expect(() => exactDuplicateProbeFilter({ journalCode: "90", yourRef: "a' or 1 eq 1" })).toThrow(
      RangeError,
    );
    expect(() => exactDuplicateProbeFilter({ journalCode: "9'0", yourRef: "a" })).toThrow(
      RangeError,
    );
  });
});

describe("createExactWriter", () => {
  const opts = { division: 123, jobId: "match", priority: "user" } as const;
  const xml = (() => {
    const r = buildMatchSetXml({
      glAccountCode: "1300",
      relationCode: "1",
      currency: "EUR",
      reference: "r",
      lines: [
        { entryNumber: 1, amountMinor: 5 },
        { entryNumber: 2, amountMinor: -5 },
      ],
    });
    if (!r.ok) throw new Error(r.error);
    return r.xml;
  })();

  it("is disabled unless writeEnabled is exactly true; transport never called", async () => {
    for (const writeEnabled of [false, "true", 1, undefined] as unknown as boolean[]) {
      const { transport, calls } = scripted([]);
      const w = createExactWriter(transport, { ...opts, writeEnabled });
      await expect(w.createBankEntry(built())).rejects.toBeInstanceOf(ExactWriteDisabledError);
      await expect(w.submitMatchSet(xml)).rejects.toBeInstanceOf(ExactWriteDisabledError);
      expect(calls).toHaveLength(0);
    }
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

  it("posts the bank entry once with the idempotency header", async () => {
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
      api: "rest",
      body: b.body,
    });
    expect(calls[0]?.headers?.["X-Idempotency-Key"]).toBe(KEY);
  });

  it("never retries a POST, whatever the failure", async () => {
    for (const reply of [status(500, "boom"), status(502), status(503)]) {
      const { transport, calls } = scripted([reply, reply]);
      const w = createExactWriter(transport, { ...opts, writeEnabled: true });
      await expect(w.createBankEntry(built())).rejects.toBeInstanceOf(ExactApiError);
      await expect(w.submitMatchSet(xml)).rejects.toBeInstanceOf(ExactApiError);
      expect(calls).toHaveLength(2); // one call per method, none repeated
    }
    const lost = scripted([new Error("network")]);
    const w = createExactWriter(lost.transport, { ...opts, writeEnabled: true });
    await expect(w.createBankEntry(built())).rejects.toThrow("network");
    expect(lost.calls).toHaveLength(1);
  });

  it("maps 401, 429 and error bodies without leaking IBANs", async () => {
    const w = (r: ReturnType<typeof status>) =>
      createExactWriter(scripted([r]).transport, { ...opts, writeEnabled: true });
    await expect(w(status(401)).createBankEntry(built())).rejects.toBeInstanceOf(ExactAuthError);
    await expect(
      w(status(429, "", { "retry-after": "7" })).createBankEntry(built()),
    ).rejects.toBeInstanceOf(ExactRateLimitedError);
    const bad = status(400, '{"error":{"message":{"value":"bad NL91ABNA0417164300"}}}');
    const e = await w(bad)
      .createBankEntry(built())
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExactApiError);
    expect((e as Error).message).toContain("NL91****4300");
    expect((e as Error).message).not.toContain("ABNA");
    const e2 = await w(status(400, '{"error":{"message":"plain"}}'))
      .createBankEntry(built())
      .catch((x: unknown) => x);
    expect((e2 as Error).message).toContain("plain");
  });

  it("submits the MatchSet and never treats acceptance as proof", async () => {
    const { transport, calls } = scripted([ok(SUCCESS)]);
    const w = createExactWriter(transport, { ...opts, writeEnabled: true });
    const r = await w.submitMatchSet(xml, { idempotencyKey: KEY });
    expect(r).toMatchObject({ accepted: true, readBackRequired: true });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/docs/XMLUpload.aspx",
      query: { Topic: "MatchSets" },
      api: "xml",
    });
    expect(calls[0]?.headers?.["X-Idempotency-Key"]).toBe(KEY);
  });

  it("refuses to send anything that is not a built MatchSets document", async () => {
    const { transport, calls } = scripted([]);
    const w = createExactWriter(transport, { ...opts, writeEnabled: true });
    await expect(w.submitMatchSet("<eExact><Other/></eExact>")).rejects.toBeInstanceOf(RangeError);
    await expect(
      w.submitMatchSet(xml.replace("<eExact", '<!DOCTYPE a [<!ENTITY b "c">]><eExact')),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
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
    expect(await w.findBankEntryLineByRef({ journalCode: "90", yourRef: "tx-3" })).toEqual([
      { id: null, entryId: null, entryNumber: null, yourRef: null, amountFc: null },
    ]);
  });

  it("reads open item lines back for verification", async () => {
    const rows = {
      d: { results: [{ ID: G1, EntryNumber: 5, AmountFC: 0, Currency: "EUR", IsFullyPaid: true }] },
    };
    const { transport, calls } = scripted([ok(JSON.stringify(rows)), ok(JSON.stringify(rows))]);
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
    expect(verifyMatchSetApplied(r, [{ entryNumber: 5, currency: "EUR" }])).toEqual({
      verified: true,
    });
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
