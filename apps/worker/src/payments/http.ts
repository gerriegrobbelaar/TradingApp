/** Small request helpers shared by the payment routes (body reading, ids, errors). */
import { maskIbans } from "@camelthorn/core";
import { json, type Ctx } from "../router";
import { PaymentError } from "./store";

export async function readBody(
  ctx: Ctx,
  allowed: readonly string[],
): Promise<Record<string, unknown>> {
  const len = Number(ctx.request.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > 20_000) throw new PaymentError("bad_request", 400);
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    throw new PaymentError("bad_request", 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new PaymentError("bad_request", 400);
  }
  const rec = body as Record<string, unknown>;
  if (Object.keys(rec).some((k) => !allowed.includes(k)))
    throw new PaymentError("bad_request", 400);
  return rec;
}

export function idParam(ctx: Ctx, name = "id"): number {
  const raw = ctx.params[name] ?? "";
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw new PaymentError("not_found", 404);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new PaymentError("not_found", 404);
  return n;
}

/** A written note: trimmed, no control characters, min..max characters; IBANs typed into it are masked. */
export function note(v: unknown, min: number, max: number, code: string): string {
  if (typeof v !== "string") throw new PaymentError(code, 400);
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
  if (t.length < min || t.length > max) throw new PaymentError(code, 400);
  return maskIbans(t);
}

export function actor(ctx: Ctx): string {
  if (!ctx.session) throw new PaymentError("unauthenticated", 401);
  return ctx.session.email;
}

export type Handler = (ctx: Ctx) => Promise<Response>;

export const safely =
  (fn: Handler): Handler =>
  async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      if (err instanceof PaymentError) {
        return json({ error: err.code, ...err.extra }, err.status);
      }
      throw err;
    }
  };
