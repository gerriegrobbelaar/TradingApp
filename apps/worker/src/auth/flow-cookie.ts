/**
 * Sign-in round trip (state, nonce, PKCE verifier) lives in a short-lived HMAC-signed HttpOnly
 * cookie rather than a D1 table: it needs no migration, no cleanup job and no write before the
 * user is even authenticated (so anonymous traffic cannot grow the database). The cookie is
 * bound to the browser that started the login, which is exactly what `state` must prove.
 */
import { fromBase64Url, hmacSign, hmacVerify, toBase64Url } from "./crypto";

export const FLOW_TTL_SECONDS = 600;

export interface FlowState {
  state: string;
  nonce: string;
  verifier: string;
  stepUp: boolean;
  returnTo: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sealFlow(secret: string, flow: FlowState): Promise<string> {
  const payload = toBase64Url(enc.encode(JSON.stringify(flow)));
  return `${payload}.${await hmacSign(secret, payload)}`;
}

export async function openFlow(
  secret: string,
  value: string | undefined,
  nowMs: number,
): Promise<FlowState | null> {
  if (!value) return null;
  const [payload, sig, extra] = value.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  if (!(await hmacVerify(secret, payload, sig))) return null;
  try {
    const f = JSON.parse(dec.decode(fromBase64Url(payload))) as Partial<FlowState>;
    if (
      typeof f.state !== "string" ||
      typeof f.nonce !== "string" ||
      typeof f.verifier !== "string" ||
      typeof f.stepUp !== "boolean" ||
      typeof f.returnTo !== "string" ||
      typeof f.exp !== "number" ||
      f.exp < nowMs
    ) {
      return null;
    }
    return f as FlowState;
  } catch {
    return null;
  }
}
