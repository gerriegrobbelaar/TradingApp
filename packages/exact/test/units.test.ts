import { describe, expect, it } from "vitest";
import {
  ExactApiError,
  buildXmlEnvelope,
  maskIban,
  parseExactDate,
  parseJsonRawNumbers,
  parseRateLimitHeaders,
  parseXmlResponse,
  sanitizeForMessage,
  xmlElement,
  xmlEscape,
  xmlTextElement,
  xmlUnescape,
} from "../src";
import { retryAfterFromHeaders } from "../src/rate-limit";
import { XML_ERR, XML_OK } from "./fixtures";

describe("parseJsonRawNumbers", () => {
  it("keeps number text, including exponents, negatives and 64-bit values", () => {
    const v = parseJsonRawNumbers(
      `{"a":1234.5,"b":1e-7,"c":-0.0,"d":9007199254740993,"e":[1,2.50],"s":"12 \\" 34","t":true,"n":null}`,
    );
    expect(v).toEqual({
      a: "1234.5",
      b: "1e-7",
      c: "-0.0",
      d: "9007199254740993",
      e: ["1", "2.50"],
      s: '12 " 34',
      t: true,
      n: null,
    });
  });

  it("does not touch digits inside strings", () => {
    expect(parseJsonRawNumbers(`{"x":"1,2 3"}`)).toEqual({ x: "1,2 3" });
  });

  it("leaves digits in keys, escaped quotes and unicode escapes alone", () => {
    expect(
      parseJsonRawNumbers(String.raw`{"12":1,"a\"3":"x\\","b":"1 -2 1e5","c":[[1,[-2e+3]],[]]}`),
    ).toEqual({ "12": "1", 'a"3': "x\\", b: "1 -2 1e5", c: [["1", ["-2e+3"]], []] });
  });

  it("keeps large integers and long decimals exact", () => {
    expect(
      parseJsonRawNumbers(`[123456789012345678901234567890,0.1000000000000000055511]`),
    ).toEqual(["123456789012345678901234567890", "0.1000000000000000055511"]);
    expect(parseJsonRawNumbers(" \n\t-0 ")).toBe("-0");
    expect(parseJsonRawNumbers("0")).toBe("0");
    expect(parseJsonRawNumbers(`{"a":0.5E-3}`)).toEqual({ a: "0.5E-3" });
  });

  it.each([
    "{",
    "007",
    `{"a":01}`,
    `{"a":-01}`,
    `{"a":-}`,
    `{"a":1.}`,
    `{"a":.5}`,
    `{"a":+1}`,
    `{"a":1e}`,
    `{"a":1-2}`,
    `{"a":--1}`,
    `{"a":1.2.3}`,
    `{"a":NaN}`,
    `{"a":-Infinity}`,
    `{"a":"unterminated}`,
    '{"a":"x\\',
    `{"a":1 2}`,
  ])("rejects invalid JSON %s with BAD_JSON and no body text", (text) => {
    let caught: unknown = null;
    try {
      parseJsonRawNumbers(text);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExactApiError);
    expect((caught as ExactApiError).code).toBe("BAD_JSON");
    expect((caught as ExactApiError).message).toBe("Exact returned invalid JSON");
  });
});

describe("parseExactDate", () => {
  it("parses epoch milliseconds to ISO UTC", () => {
    expect(parseExactDate("/Date(1700000000000)/")).toBe("2023-11-14T22:13:20.000Z");
    expect(parseExactDate("/Date(0)/")).toBe("1970-01-01T00:00:00.000Z");
    expect(parseExactDate("/Date(-86400000)/")).toBe("1969-12-31T00:00:00.000Z");
    expect(parseExactDate("/Date(1700000000000+0100)/")).toBe("2023-11-14T22:13:20.000Z");
  });

  it("passes null through", () => {
    expect(parseExactDate(null)).toBeNull();
    expect(parseExactDate(undefined)).toBeNull();
  });

  it("rejects other shapes", () => {
    expect(() => parseExactDate("2023-11-14")).toThrow(ExactApiError);
    expect(() => parseExactDate(5)).toThrow(ExactApiError);
    expect(() => parseExactDate("/Date(9999999999999999)/")).toThrow(ExactApiError);
  });
});

describe("parseRateLimitHeaders", () => {
  it("reads all six headers case-insensitively", () => {
    const info = parseRateLimitHeaders({
      "x-ratelimit-limit": "5000",
      "X-RateLimit-Remaining": "4990",
      "X-RATELIMIT-RESET": "1700086400000",
      "X-RateLimit-Minutely-Limit": "60",
      "X-RateLimit-Minutely-Remaining": "0",
      "X-RateLimit-Minutely-Reset": "1700000060000",
      "Retry-After": "12",
    });
    expect(info).toEqual({
      daily: { limit: 5000, remaining: 4990, resetAtMs: 1700086400000 },
      minutely: { limit: 60, remaining: 0, resetAtMs: 1700000060000 },
      retryAfterMs: 12000,
    });
  });

  it("returns nulls for missing or malformed values", () => {
    const info = parseRateLimitHeaders({
      "X-RateLimit-Limit": "abc",
      "X-RateLimit-Remaining": "99999999999999999999",
    });
    expect(info.daily).toEqual({ limit: null, remaining: null, resetAtMs: null });
    expect(info.minutely.limit).toBeNull();
    expect(info.retryAfterMs).toBeNull();
  });
});

describe("retryAfterFromHeaders", () => {
  const now = 1_000_000;
  it("prefers Retry-After", () => {
    expect(
      retryAfterFromHeaders({ "retry-after": "3", "x-ratelimit-minutely-reset": "2000000" }, now),
    ).toBe(3000);
  });
  it("uses the daily reset when the daily budget is gone", () => {
    expect(
      retryAfterFromHeaders(
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1500000",
          "x-ratelimit-minutely-reset": "1010000",
        },
        now,
      ),
    ).toBe(500_000);
  });
  it("falls back to minutely reset, clamps at 0, then 60 s", () => {
    expect(retryAfterFromHeaders({ "x-ratelimit-minutely-reset": "1010000" }, now)).toBe(10_000);
    expect(retryAfterFromHeaders({ "x-ratelimit-minutely-reset": "900000" }, now)).toBe(0);
    expect(retryAfterFromHeaders({ "x-ratelimit-remaining": "0" }, now)).toBe(60_000);
    expect(retryAfterFromHeaders({}, now)).toBe(60_000);
  });
});

describe("redaction", () => {
  it("masks IBANs, keeping country, check digits and last two", () => {
    expect(maskIban("NL91 ABNA 0417 1643 00")).toBe("NL91************00");
    expect(maskIban("NL9100")).toBe("******");
  });

  it("sanitises messages", () => {
    const s = sanitizeForMessage(
      `pay NL91 ABNA 0417 1643 00 and GB29NWBK60161331926819 with Bearer tok.en-1 "refresh_token":"abc123" client_secret=zzz`,
    );
    expect(s).not.toMatch(/ABNA 0417|NWBK6016|tok\.en|abc123|zzz/);
    expect(s).toContain("[redacted]");
    expect(sanitizeForMessage("token eyJhbGciOi.eyJzdWIiOiIx.c2ln here")).toBe(
      "token [redacted] here",
    );
  });

  it("truncates", () => {
    expect(sanitizeForMessage("x".repeat(500)).length).toBe(303);
  });
});

describe("xml helpers", () => {
  it("escapes and unescapes", () => {
    expect(xmlEscape(`<a b="c" d='e'>&`)).toBe("&lt;a b=&quot;c&quot; d=&apos;e&apos;&gt;&amp;");
    expect(xmlUnescape("&lt;&amp;lt;&#65;&#x42;&gt;&quot;&apos;")).toBe("<&lt;AB>\"'");
    expect(xmlUnescape("&amp;#65;&amp;amp;")).toBe("&#65;&amp;");
    expect(xmlUnescape(xmlEscape(`a&b<c>'"&amp;`))).toBe(`a&b<c>'"&amp;`);
    expect(xmlEscape("tab\tlf\ncr\r é €")).toBe("tab\tlf\ncr\r é €");
  });

  it("refuses characters XML cannot carry", () => {
    expect(() => xmlEscape("a\u0000b")).toThrow(RangeError);
    expect(() => xmlEscape("a\u001Fb")).toThrow(RangeError);
    expect(() => xmlTextElement("A", "\u000B")).toThrow(RangeError);
  });

  it("never throws on hostile numeric references and does not expand other entities", () => {
    expect(xmlUnescape("&#99999999;&#xD800;&#x110000;")).toBe("\uFFFD\uFFFD\uFFFD");
    expect(xmlUnescape("&xxe;&nbsp;")).toBe("&xxe;&nbsp;");
  });

  it("refuses DOCTYPE and ENTITY declarations (XXE, entity expansion)", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE eExact [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><eExact><Messages><Message type="2"><Description>&xxe;</Description></Message></Messages></eExact>`;
    expect(() => parseXmlResponse(xxe)).toThrow(ExactApiError);
    const lol = `<!doctype x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><eExact/>`;
    expect(() => parseXmlResponse(lol)).toThrow(/DTD/);
    const inner = `<eExact><!ENTITY a "x"></eExact>`;
    expect(() => parseXmlResponse(inner)).toThrow(/DTD/);
  });

  it("refuses anything that is not an eExact document", () => {
    for (const body of ["", "<html>error</html>", "OK", '<?xml version="1.0"?><Error/>']) {
      expect(() => parseXmlResponse(body)).toThrow(ExactApiError);
    }
    expect(parseXmlResponse("\uFEFF<eExact/>").ok).toBe(true);
  });

  it("handles self-closing, single-quoted, CDATA and unclosed messages", () => {
    const r = parseXmlResponse(
      `<eExact><Messages><Message type='2'/><Message type="0"><Description><![CDATA[a <b> & c]]></Description></Message><Message type="2"><Description>done</Description></Message></Messages></eExact>`,
    );
    expect(r.messages).toEqual([
      { severity: "info", description: "" },
      { severity: "error", description: "a <b> & c" },
      { severity: "info", description: "done" },
    ]);
    expect(r.ok).toBe(false);
    expect(parseXmlResponse('<eExact><Message type="2">').messages).toEqual([
      { severity: "info", description: "" },
    ]);
  });

  it("builds elements and the envelope", () => {
    expect(xmlElement("A", { b: 'x"y' }, "t")).toBe('<A b="x&quot;y">t</A>');
    expect(xmlElement("A")).toBe("<A/>");
    expect(xmlTextElement("Note", "a<b")).toBe("<Note>a&lt;b</Note>");
    expect(() => xmlElement("1bad")).toThrow(RangeError);
    expect(() => xmlElement("A", { "b c": "x" })).toThrow(RangeError);
    const env = buildXmlEnvelope("<MatchSets/>");
    expect(env.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(env).toContain("<eExact");
    expect(env.endsWith("<MatchSets/></eExact>")).toBe(true);
  });

  it("parses response messages", () => {
    expect(parseXmlResponse(XML_OK).ok).toBe(true);
    const r = parseXmlResponse(XML_ERR);
    expect(r.ok).toBe(false);
    expect(r.messages).toEqual([
      { severity: "error", description: "Entry <12> is already matched" },
      { severity: "warning", description: "Warn" },
    ]);
    expect(parseXmlResponse("<eExact/>")).toEqual({ ok: true, messages: [] });
    expect(
      parseXmlResponse('<eExact><Message type="9"><Description>?</Description></Message></eExact>')
        .messages[0]?.severity,
    ).toBe("error");
    expect(parseXmlResponse("<eExact><Message><x/></Message></eExact>").messages[0]).toEqual({
      severity: "error",
      description: "",
    });
  });
});
