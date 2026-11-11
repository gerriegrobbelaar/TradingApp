import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_WEBHOOK_BODY_BYTES, parseWebhookEvent, verifyRevolutWebhook } from "../src/webhook";

const SECRET = "wsk_test_secret_value";
const NOW = 1_700_000_000_000;
const TS = String(NOW);
const BODY =
  '{"event":"TransactionCreated","timestamp":"2023-11-14T22:13:20.000Z","data":{"id":"tx-1","state":"pending","request_id":"r-1"}}';

/** Independent implementation of the documented scheme. */
function sign(body: string, ts = TS, secret = SECRET): string {
  return createHmac("sha256", secret).update(`v1.${ts}.${body}`).digest("hex");
}

const base = {
  rawBody: BODY,
  signatureHeader: `v1=${sign(BODY)}`,
  timestampHeader: TS,
  signingSecret: SECRET,
  nowMs: NOW,
};

describe("verifyRevolutWebhook", () => {
  it("accepts a correct signature (string and ArrayBuffer bodies)", async () => {
    expect(await verifyRevolutWebhook(base)).toEqual({ ok: true });
    const ab = new TextEncoder().encode(BODY);
    expect(
      await verifyRevolutWebhook({
        ...base,
        rawBody: ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength) as ArrayBuffer,
      }),
    ).toEqual({ ok: true });
  });

  it("has a fixed test vector", async () => {
    // Computed offline with: printf 'v1.1700000000000.{"a":1}' | openssl dgst -sha256 -hmac secret
    const body = '{"a":1}';
    const hex = createHmac("sha256", "secret").update(`v1.1700000000000.${body}`).digest("hex");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await verifyRevolutWebhook({
        ...base,
        rawBody: body,
        signingSecret: "secret",
        signatureHeader: `v1=${hex}`,
      }),
    ).toEqual({ ok: true });
  });

  it("handles multibyte bodies by their UTF-8 bytes", async () => {
    const body = '{"reference":"café €"}';
    expect(
      await verifyRevolutWebhook({ ...base, rawBody: body, signatureHeader: `v1=${sign(body)}` }),
    ).toEqual({ ok: true });
  });

  it("rejects tampered body, timestamp header, signature and wrong secret", async () => {
    expect(await verifyRevolutWebhook({ ...base, rawBody: `${BODY} ` })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyRevolutWebhook({ ...base, timestampHeader: String(NOW + 1) })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const flipped = sign(BODY).replace(/^./, (c) => (c === "0" ? "1" : "0"));
    expect(await verifyRevolutWebhook({ ...base, signatureHeader: `v1=${flipped}` })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyRevolutWebhook({ ...base, signingSecret: "other" })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(
      await verifyRevolutWebhook({ ...base, signatureHeader: `v1=${sign(BODY).toUpperCase()}` }),
    ).toEqual({ ok: true }); // hex case does not matter
  });

  it("accepts any of several signatures (secret rotation), ignoring other versions", async () => {
    const old = sign(BODY, TS, "old-secret");
    expect(
      await verifyRevolutWebhook({ ...base, signatureHeader: `v1=${old}, v1=${sign(BODY)}` }),
    ).toEqual({ ok: true });
    expect(
      await verifyRevolutWebhook({ ...base, signatureHeader: `v1=${sign(BODY)},v1=${old}` }),
    ).toEqual({ ok: true });
    expect(
      await verifyRevolutWebhook({
        ...base,
        signatureHeader: `v2=${sign(BODY)}, v1=${sign(BODY)}`,
      }),
    ).toEqual({ ok: true });
    expect(await verifyRevolutWebhook({ ...base, signatureHeader: `v1=${old},v1=${old}` })).toEqual(
      { ok: false, reason: "bad_signature" },
    );
  });

  it("enforces the replay window in both directions", async () => {
    const at = async (delta: number) => {
      const ts = String(NOW + delta);
      return verifyRevolutWebhook({
        ...base,
        timestampHeader: ts,
        signatureHeader: `v1=${sign(BODY, ts)}`,
      });
    };
    expect(await at(0)).toEqual({ ok: true });
    expect(await at(-300_000)).toEqual({ ok: true });
    expect(await at(300_000)).toEqual({ ok: true });
    expect(await at(-300_001)).toEqual({ ok: false, reason: "timestamp_out_of_range" });
    expect(await at(300_001)).toEqual({ ok: false, reason: "timestamp_out_of_range" });
    expect(await verifyRevolutWebhook({ ...base, toleranceMs: 1000, nowMs: NOW + 1001 })).toEqual({
      ok: false,
      reason: "timestamp_out_of_range",
    });
  });

  it("refuses a timestamp in seconds instead of guessing the unit", async () => {
    // A correctly signed seconds value would otherwise be read as 1970 or rescaled by guesswork.
    const ts = String(NOW / 1000);
    expect(
      await verifyRevolutWebhook({
        ...base,
        timestampHeader: ts,
        signatureHeader: `v1=${sign(BODY, ts)}`,
      }),
    ).toEqual({ ok: false, reason: "bad_timestamp" });
    // Microseconds (16 digits) are refused too.
    const us = `${TS}000`;
    expect(
      await verifyRevolutWebhook({
        ...base,
        timestampHeader: us,
        signatureHeader: `v1=${sign(BODY, us)}`,
      }),
    ).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("uses the trimmed header text in the signed string", async () => {
    expect(await verifyRevolutWebhook({ ...base, timestampHeader: ` ${TS} ` })).toEqual({
      ok: true,
    });
  });

  it("rejects a duplicated timestamp header (joined with a comma)", async () => {
    expect(await verifyRevolutWebhook({ ...base, timestampHeader: `${TS}, ${TS}` })).toEqual({
      ok: false,
      reason: "bad_timestamp",
    });
  });

  it("fails closed on a bad clock or tolerance instead of skipping the window", async () => {
    await expect(verifyRevolutWebhook({ ...base, nowMs: Number.NaN })).rejects.toThrow(RangeError);
    for (const toleranceMs of [Number.NaN, -1, 300_001, Number.POSITIVE_INFINITY]) {
      await expect(verifyRevolutWebhook({ ...base, toleranceMs })).rejects.toThrow(RangeError);
    }
  });

  it("rejects missing, empty and malformed headers", async () => {
    for (const v of [undefined, null, "", "   "]) {
      expect(await verifyRevolutWebhook({ ...base, signatureHeader: v })).toEqual({
        ok: false,
        reason: "missing_header",
      });
      expect(await verifyRevolutWebhook({ ...base, timestampHeader: v })).toEqual({
        ok: false,
        reason: "missing_header",
      });
    }
    for (const ts of [
      "abc",
      "-5",
      "1.5",
      "1e12",
      "0x10",
      "12345678901234567",
      "+1700000000000",
      "1700000000000.0",
      "1 700000000000",
    ]) {
      expect(await verifyRevolutWebhook({ ...base, timestampHeader: ts })).toEqual({
        ok: false,
        reason: "bad_timestamp",
      });
    }
    for (const sig of [
      "garbage",
      "v1=",
      "v1=zz",
      `v1=${"a".repeat(63)}`,
      `sha256=${sign(BODY)}`,
      ",,,",
      `v1 = ${sign(BODY)}`,
      `v1=${sign(BODY)}x`,
      `v1=${sign(BODY)};v1=${sign(BODY)}`,
      `V1=${sign(BODY)}`,
      `v1=${sign(BODY).slice(0, 62)} ${sign(BODY).slice(62)}`,
    ]) {
      expect(await verifyRevolutWebhook({ ...base, signatureHeader: sig })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("rejects bodies over 1 MB without hashing them, and accepts one at the limit", async () => {
    const big = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    expect(
      await verifyRevolutWebhook({ ...base, rawBody: big, signatureHeader: `v1=${sign(big)}` }),
    ).toEqual({ ok: false, reason: "malformed" });
    const edge = "y".repeat(MAX_WEBHOOK_BODY_BYTES);
    expect(
      await verifyRevolutWebhook({ ...base, rawBody: edge, signatureHeader: `v1=${sign(edge)}` }),
    ).toEqual({ ok: true });
    const multi = "€".repeat(400_000); // 3 bytes each: over the limit in bytes, under in chars
    expect(
      await verifyRevolutWebhook({ ...base, rawBody: multi, signatureHeader: `v1=${sign(multi)}` }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("requires a signing secret and never verifies with an empty key", async () => {
    for (const signingSecret of ["", "   "]) {
      const empty = createHmac("sha256", "").update(`v1.${TS}.${BODY}`).digest("hex");
      await expect(
        verifyRevolutWebhook({ ...base, signingSecret, signatureHeader: `v1=${empty}` }),
      ).rejects.toThrow(RangeError);
    }
  });

  it("accepts whitespace around entries and the joined form of a repeated header", async () => {
    expect(
      await verifyRevolutWebhook({ ...base, signatureHeader: `  v1=${sign(BODY)}  ` }),
    ).toEqual({ ok: true });
    // Headers.get() joins two Revolut-Signature headers with ", ".
    const h = new Headers();
    h.append("Revolut-Signature", `v1=${sign(BODY, TS, "old")}`);
    h.append("Revolut-Signature", `v1=${sign(BODY)}`);
    expect(
      await verifyRevolutWebhook({ ...base, signatureHeader: h.get("Revolut-Signature") }),
    ).toEqual({
      ok: true,
    });
    // A malformed entry next to a good one is skipped, not fatal.
    expect(
      await verifyRevolutWebhook({ ...base, signatureHeader: `v1=zz, v1=${sign(BODY)}` }),
    ).toEqual({ ok: true });
  });

  it("caps the number of signature candidates", async () => {
    const many = Array.from({ length: 5 }, (_, i) => `v1=${sign(BODY, TS, `s${i}`)}`);
    expect(
      await verifyRevolutWebhook({
        ...base,
        signatureHeader: [...many.slice(0, 4), `v1=${sign(BODY)}`].join(","),
      }),
    ).toEqual({ ok: true });
    expect(
      await verifyRevolutWebhook({
        ...base,
        signatureHeader: [...many, `v1=${sign(BODY)}`].join(","),
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("verifies the same bytes from string, ArrayBuffer and Uint8Array (BOM, non-ASCII)", async () => {
    const text = '\uFEFF{"reference":"Zoë – 東京 🚀"}';
    const bytes = new TextEncoder().encode(text);
    expect(bytes[0]).toBe(0xef); // the BOM is part of the signed bytes
    const sig = createHmac("sha256", SECRET)
      .update(Buffer.concat([Buffer.from(`v1.${TS}.`), Buffer.from(bytes)]))
      .digest("hex");
    for (const rawBody of [text, bytes, bytes.buffer.slice(0) as ArrayBuffer]) {
      expect(
        await verifyRevolutWebhook({ ...base, rawBody, signatureHeader: `v1=${sig}` }),
      ).toEqual({
        ok: true,
      });
    }
    // Decoding with text() would drop the BOM: those bytes no longer verify.
    const decoded = new TextDecoder().decode(bytes);
    expect(
      await verifyRevolutWebhook({ ...base, rawBody: decoded, signatureHeader: `v1=${sig}` }),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    // Invalid UTF-8 bytes are signed as bytes too.
    const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const rawSig = createHmac("sha256", SECRET)
      .update(Buffer.concat([Buffer.from(`v1.${TS}.`), Buffer.from(raw)]))
      .digest("hex");
    expect(
      await verifyRevolutWebhook({ ...base, rawBody: raw, signatureHeader: `v1=${rawSig}` }),
    ).toEqual({
      ok: true,
    });
  });

  it("rejects an over-limit byte body", async () => {
    const big = new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1);
    expect(await verifyRevolutWebhook({ ...base, rawBody: big })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("matches an independent vector computed with node:crypto over a fixed input", async () => {
    // printf 'v1.1700000000123.{}' | openssl dgst -sha256 -hmac whsec
    const hex = "1b91eb272d7c0d911e923372e30ad1b2930b95e69ba9ec499b60358c366e2173";
    expect(createHmac("sha256", "whsec").update("v1.1700000000123.{}").digest("hex")).toBe(hex);
    expect(
      await verifyRevolutWebhook({
        rawBody: "{}",
        signatureHeader: `v1=${hex}`,
        timestampHeader: "1700000000123",
        signingSecret: "whsec",
        nowMs: 1_700_000_000_123,
      }),
    ).toEqual({ ok: true });
    // The timestamp is part of the signed string: the same signature with a different header fails.
    expect(
      await verifyRevolutWebhook({
        rawBody: "{}",
        signatureHeader: `v1=${hex}`,
        timestampHeader: "1700000000124",
        signingSecret: "whsec",
        nowMs: 1_700_000_000_123,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("checks the timestamp before the signature and never parses the body", async () => {
    // Invalid JSON with a good signature still verifies: verification never parses.
    const junk = "{not json";
    expect(
      await verifyRevolutWebhook({ ...base, rawBody: junk, signatureHeader: `v1=${sign(junk)}` }),
    ).toEqual({ ok: true });
  });
});

describe("parseWebhookEvent", () => {
  it("parses TransactionCreated", () => {
    expect(parseWebhookEvent(BODY)).toEqual({
      ok: true,
      event: {
        event: "TransactionCreated",
        timestamp: "2023-11-14T22:13:20.000Z",
        data: { id: "tx-1", requestId: "r-1", state: "pending" },
      },
    });
  });

  it("parses TransactionStateChanged with old and new state", () => {
    const body =
      '{"event":"TransactionStateChanged","data":{"id":"tx-2","old_state":"pending","new_state":"weird"}}';
    expect(parseWebhookEvent(body)).toEqual({
      ok: true,
      event: {
        event: "TransactionStateChanged",
        data: { id: "tx-2", oldState: "pending", newState: "unknown" },
      },
    });
  });

  it("preserves unknown events as unknown", () => {
    expect(
      parseWebhookEvent('{"event":"PayoutLinkCreated","timestamp":"t","data":{"x":1}}'),
    ).toEqual({
      ok: true,
      event: { event: "unknown", name: "PayoutLinkCreated", timestamp: "t" },
    });
    expect(parseWebhookEvent('{"data":{}}')).toEqual({ ok: true, event: { event: "unknown" } });
  });

  it("never throws on junk", () => {
    expect(parseWebhookEvent("not json")).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseWebhookEvent("[1]")).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseWebhookEvent("")).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseWebhookEvent('{"event":"TransactionCreated"}')).toEqual({
      ok: false,
      reason: "bad_shape",
    });
    expect(parseWebhookEvent('{"event":"TransactionCreated","data":{}}')).toEqual({
      ok: false,
      reason: "bad_shape",
    });
    expect(parseWebhookEvent('{"event":[1]}')).toEqual({ ok: false, reason: "bad_shape" });
    expect(parseWebhookEvent("x".repeat(MAX_WEBHOOK_BODY_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(parseWebhookEvent("€".repeat(400_000))).toEqual({ ok: false, reason: "too_large" });
    expect(parseWebhookEvent(new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual({
      ok: false,
      reason: "invalid_json",
    });
  });

  it("parses byte bodies, with or without a BOM", () => {
    const bytes = new TextEncoder().encode(`\uFEFF${BODY}`);
    const expected = parseWebhookEvent(BODY);
    expect(parseWebhookEvent(bytes)).toEqual(expected);
    expect(parseWebhookEvent(bytes.buffer.slice(0) as ArrayBuffer)).toEqual(expected);
    expect(parseWebhookEvent(`\uFEFF${BODY}`)).toEqual(expected);
  });
});
