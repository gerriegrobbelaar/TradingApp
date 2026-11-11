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

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function blank(v: string | null | undefined): v is null | undefined | "" {
  return v === null || v === undefined || v.trim() === "";
}

/** Signatures in `v1=<hex>[,v1=<hex>]` form. Other versions are ignored. */
function parseSignatures(header: string): string[] {
  const out: string[] = [];
  for (const part of header.split(",")) {
    const t = part.trim();
    if (!t.startsWith("v1=")) continue;
    const hex = t.slice(3);
    if (HEX64_RE.test(hex)) out.push(hex);
  }
  return out;
}

/**
 * Verify a Revolut webhook (v2) BEFORE parsing the body.
 *
 * The signed payload is the string `v1.{timestamp}.{rawBody}` where `timestamp` is the exact
 * `Revolut-Request-Timestamp` header text and `rawBody` the unparsed request body. The expected
 * signature is `v1=` plus the hex HMAC-SHA256 with the webhook's signing secret. During secret
 * rotation Revolut may send several comma-separated signatures; any match is enough.
 * Timestamps more than `toleranceMs` (default 5 minutes) from `nowMs` are rejected in both
 * directions. The comparison is done by WebCrypto `verify`, which is constant time.
 */
export async function verifyRevolutWebhook(opts: {
  rawBody: string | ArrayBuffer;
  signatureHeader: string | null | undefined;
  timestampHeader: string | null | undefined;
  signingSecret: string;
  nowMs: number;
  toleranceMs?: number;
}): Promise<WebhookVerifyResult> {
  if (opts.signingSecret === "") throw new RangeError("signingSecret is required");
  const { signatureHeader, timestampHeader } = opts;
  if (blank(signatureHeader) || blank(timestampHeader)) {
    return { ok: false, reason: "missing_header" };
  }
  const ts = timestampHeader.trim();
  if (!/^\d{1,16}$/.test(ts)) return { ok: false, reason: "bad_timestamp" };
  // Milliseconds; a value below 1e11 can only be seconds (1e11 ms is in 1973).
  const n = Number(ts);
  const tsMs = n < 1e11 ? n * 1000 : n;
  const tolerance = opts.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
  if (Math.abs(opts.nowMs - tsMs) > tolerance) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }
  const bodyBytes =
    typeof opts.rawBody === "string"
      ? new TextEncoder().encode(opts.rawBody)
      : new Uint8Array(opts.rawBody);
  if (bodyBytes.length > MAX_WEBHOOK_BODY_BYTES) return { ok: false, reason: "malformed" };
  const signatures = parseSignatures(signatureHeader);
  if (signatures.length === 0) return { ok: false, reason: "malformed" };

  const prefix = new TextEncoder().encode(`v1.${ts}.`);
  const payload = new Uint8Array(prefix.length + bodyBytes.length);
  payload.set(prefix, 0);
  payload.set(bodyBytes, prefix.length);
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
export function parseWebhookEvent(rawBody: string): ParseWebhookResult {
  if (new TextEncoder().encode(rawBody).length > MAX_WEBHOOK_BODY_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  let row: Row;
  try {
    row = asRow(parseJsonRawNumbers(rawBody));
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
