import { asRow, objField, optStr, parseJsonRawNumbers, reqStr, type Row } from "./json";
import { mapTransactionState, type RevolutTransactionState } from "./models";

/** Largest webhook body we look at. Real events are a few KB. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 300_000;

export type WebhookVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_header"
        | "bad_timestamp"
        | "timestamp_out_of_range"
        | "bad_signature"
        | "malformed";
    };

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
/** Epoch milliseconds, 13 digits (2001-09-09 .. 2286-11-20). Seconds (10 digits) are refused. */
const TS_MS_RE = /^\d{13}$/;
/** More candidates than any rotation needs; bounds the HMAC work an attacker can cause. */
export const MAX_WEBHOOK_SIGNATURES = 5;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function blank(v: string | null | undefined): v is null | undefined | "" {
  return v === null || v === undefined || v.trim() === "";
}

/**
 * Signatures in `v1=<hex>[,v1=<hex>]` form (a repeated header arrives joined with ", ", which is
 * the same thing). Other versions are ignored; a malformed v1 entry is skipped. null when there
 * are more than MAX_WEBHOOK_SIGNATURES entries.
 */
function parseSignatures(header: string): string[] | null {
  const parts = header.split(",");
  if (parts.length > MAX_WEBHOOK_SIGNATURES) return null;
  const out: string[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t.startsWith("v1=")) continue;
    const hex = t.slice(3);
    if (HEX64_RE.test(hex)) out.push(hex);
  }
  return out;
}

/** The raw body as bytes. Strings are UTF-8 encoded; byte input is used as is (no copy). */
function bodyBytes(raw: string | ArrayBuffer | Uint8Array): Uint8Array | null {
  if (typeof raw === "string") {
    // Each UTF-16 code unit is at least one UTF-8 byte: a longer string is over the limit.
    if (raw.length > MAX_WEBHOOK_BODY_BYTES) return null;
    const b = new TextEncoder().encode(raw);
    return b.length > MAX_WEBHOOK_BODY_BYTES ? null : b;
  }
  const b = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return b.length > MAX_WEBHOOK_BODY_BYTES ? null : b;
}

/**
 * Verify a Revolut webhook (v2) BEFORE parsing the body. Never parses the body.
 *
 * The signed payload is `v1.{timestamp}.{rawBody}` where `timestamp` is the exact
 * `Revolut-Request-Timestamp` header text and `rawBody` the unparsed request bytes. The expected
 * signature is `v1=` plus the hex (either case) HMAC-SHA256 with the webhook's signing secret
 * (its UTF-8 bytes as the key). During secret rotation Revolut may send several comma-separated
 * signatures; any match is enough (at most MAX_WEBHOOK_SIGNATURES are looked at).
 *
 * Rules:
 * - The timestamp must be epoch MILLISECONDS (13 digits). A seconds value is `bad_timestamp`
 *   rather than guessed at (ADR 0030).
 * - Timestamps more than `toleranceMs` (default and maximum 5 minutes) from `nowMs` are refused
 *   in both directions.
 * - Bodies over MAX_WEBHOOK_BODY_BYTES are refused without hashing.
 * - An empty signing secret throws (fail closed: never verify with an empty key).
 * - The comparison is WebCrypto `verify` (constant time); every candidate is checked.
 *
 * For the HTTP layer:
 * - Pass the body as bytes (`await request.arrayBuffer()`), not `request.text()`: text() drops a
 *   leading BOM and replaces invalid UTF-8, which changes the signed bytes.
 * - Answer every failure with the same plain 401 (no reason in the response); reasons are for
 *   internal logs and metrics only.
 * - The verifier cannot detect a replay inside the window: dedupe in the ingest (event id or
 *   transaction id + state, idempotent upsert), which also covers Revolut's own retries.
 */
export async function verifyRevolutWebhook(opts: {
  rawBody: string | ArrayBuffer | Uint8Array;
  signatureHeader: string | null | undefined;
  timestampHeader: string | null | undefined;
  signingSecret: string;
  nowMs: number;
  toleranceMs?: number;
}): Promise<WebhookVerifyResult> {
  if (typeof opts.signingSecret !== "string" || opts.signingSecret.trim() === "") {
    throw new RangeError("signingSecret is required");
  }
  if (!Number.isFinite(opts.nowMs)) throw new RangeError("nowMs must be epoch milliseconds");
  const tolerance = opts.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > DEFAULT_WEBHOOK_TOLERANCE_MS) {
    throw new RangeError("toleranceMs must be between 0 and 300000");
  }
  const { signatureHeader, timestampHeader } = opts;
  if (blank(signatureHeader) || blank(timestampHeader)) {
    return { ok: false, reason: "missing_header" };
  }
  const ts = timestampHeader.trim();
  if (!TS_MS_RE.test(ts)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(opts.nowMs - Number(ts)) > tolerance) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }
  const body = bodyBytes(opts.rawBody);
  if (body === null) return { ok: false, reason: "malformed" };
  const signatures = parseSignatures(signatureHeader);
  if (signatures === null || signatures.length === 0) return { ok: false, reason: "malformed" };

  const prefix = new TextEncoder().encode(`v1.${ts}.`);
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix, 0);
  payload.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(opts.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let match = false;
  for (const hex of signatures) {
    // No early exit: every candidate is checked.
    const ok = await crypto.subtle.verify("HMAC", key, hexToBytes(hex), payload);
    match = match || ok;
  }
  return match ? { ok: true } : { ok: false, reason: "bad_signature" };
}

// ---- events --------------------------------------------------------------------------------

export interface RevolutWebhookData {
  id: string;
  requestId?: string;
  /** TransactionCreated: the state in the payload. */
  state?: RevolutTransactionState;
  /** TransactionStateChanged. */
  oldState?: RevolutTransactionState;
  newState?: RevolutTransactionState;
}

export type RevolutWebhookEvent =
  | {
      event: "TransactionCreated" | "TransactionStateChanged";
      timestamp?: string;
      data: RevolutWebhookData;
    }
  | { event: "unknown"; name?: string; timestamp?: string };

export type ParseWebhookResult =
  | { ok: true; event: RevolutWebhookEvent }
  | { ok: false; reason: "too_large" | "invalid_json" | "bad_shape" };

function mapData(d: Row): RevolutWebhookData {
  const out: RevolutWebhookData = { id: reqStr(d, "id") };
  const requestId = optStr(d, "request_id");
  if (requestId !== undefined) out.requestId = requestId;
  if (d["state"] !== undefined) out.state = mapTransactionState(d["state"]);
  if (d["old_state"] !== undefined) out.oldState = mapTransactionState(d["old_state"]);
  if (d["new_state"] !== undefined) out.newState = mapTransactionState(d["new_state"]);
  return out;
}

/**
 * Parse an event body. Call only after `verifyRevolutWebhook` returned ok. Never throws and never
 * logs the body. Unknown event names come back as `{ event: 'unknown' }`; a known event whose
 * payload has no transaction id is `bad_shape`.
 */
export function parseWebhookEvent(rawBody: string | ArrayBuffer | Uint8Array): ParseWebhookResult {
  const bytes = bodyBytes(rawBody);
  if (bytes === null) return { ok: false, reason: "too_large" };
  let row: Row;
  try {
    // Fatal decoding: invalid UTF-8 is invalid_json, never silently replaced. A BOM is dropped.
    const text =
      typeof rawBody === "string"
        ? rawBody
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    row = asRow(parseJsonRawNumbers(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  try {
    const name = optStr(row, "event");
    const timestamp = optStr(row, "timestamp");
    const withTs = <T extends object>(o: T): T & { timestamp?: string } =>
      timestamp === undefined ? o : { ...o, timestamp };
    if (name !== "TransactionCreated" && name !== "TransactionStateChanged") {
      return {
        ok: true,
        event: withTs(
          name === undefined ? { event: "unknown" as const } : { event: "unknown" as const, name },
        ),
      };
    }
    const data = objField(row, "data");
    if (data === undefined) return { ok: false, reason: "bad_shape" };
    return { ok: true, event: withTs({ event: name, data: mapData(data) }) };
  } catch {
    return { ok: false, reason: "bad_shape" };
  }
}
