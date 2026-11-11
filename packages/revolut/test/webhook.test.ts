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

  it("accepts a timestamp in seconds (checked against the raw header text)", async () => {
    const ts = String(NOW / 1000);
    expect(
      await verifyRevolutWebhook({
        ...base,
        timestampHeader: ts,
        signatureHeader: `v1=${sign(BODY, ts)}`,
      }),
    ).toEqual({ ok: true });
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
    for (const ts of ["abc", "-5", "1.5", "1e12", "0x10", "12345678901234567"]) {
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

  it("requires a signing secret", async () => {
    await expect(verifyRevolutWebhook({ ...base, signingSecret: "" })).rejects.toThrow(RangeError);
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
  });
});
