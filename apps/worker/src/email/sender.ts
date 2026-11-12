/**
 * E-mail sending abstraction (ADR 0046, provisional until open decision 5 is answered).
 *
 *  disabled  the default: nothing is sent; callers record `skipped_not_configured`
 *  https     one JSON POST to `https://<host>/emails` with `Authorization: Bearer <EMAIL_API_KEY>`;
 *            the body is {from, to[], subject, html, text} and a 2xx answer may carry {"id": "..."}
 *            (the shape of the common transactional APIs, for example Resend). The host and the
 *            sender address are SETTINGS (dq.notifications); the key is the Workers secret
 *            EMAIL_API_KEY. No provider is named in code and no secret is in the repository.
 *
 * The result classification is what makes claim-then-send safe: only a definite refusal (4xx other
 * than 408) is `failed` and may be tried again; anything we cannot be sure about (timeout, network
 * error, 5xx, redirect, unreadable answer to a 2xx is still `sent`) is `unknown` and is NEVER sent
 * again by the code. Nothing here logs: not the key, not the addresses, not the body, not the
 * provider's answer text.
 */
import {
  isPublicHostName,
  normalizeFromAddress,
  type DqNotificationSettings,
  type EmailMessage,
  type EmailSendResult,
} from "@camelthorn/core";

export interface EmailSender {
  readonly kind: "disabled" | "https";
  /** Pause a caller leaves between two sends of one run (rate limits are per second); default 0. */
  readonly spacingMs?: number;
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

export const disabledSender: EmailSender = {
  kind: "disabled",
  send: () => Promise.resolve({ status: "skipped_not_configured" }),
};

export const SEND_TIMEOUT_MS = 10_000;
/** Pause between two mails of one run (transactional APIs limit requests per second). */
export const SEND_SPACING_MS = 300;
/** A Retry-After longer than this is capped (the value is only reported, never slept on). */
const MAX_RETRY_AFTER_S = 3_600;
/** The provider's answer is read up to this many bytes (only for the message id). */
export const MAX_ANSWER_BYTES = 16_384;
const MAX_RECIPIENTS = 100;

/** A plain, header-safe address (the same shape as the sender address setting). */
const plainAddress = (a: string): boolean => normalizeFromAddress(a) === a && a !== "";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Reads at most `max` bytes of a body; null when it is longer or unreadable. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** A provider id we are willing to store: printable ASCII without spaces, at most 200 characters. */
const safeId = (v: unknown): string | null =>
  typeof v === "string" && /^[\x21-\x7e]{1,200}$/.test(v) ? v : null;

export interface HttpsSenderOptions {
  host: string;
  from: string;
  apiKey: string;
  /** Test seam; defaults to the global fetch resolved at call time. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function httpsSender(opts: HttpsSenderOptions): EmailSender {
  return {
    kind: "https",
    spacingMs: SEND_SPACING_MS,
    async send(msg: EmailMessage): Promise<EmailSendResult> {
      if (msg.to.length === 0) return { status: "failed", code: "no_recipients" };
      // Defence in depth: the settings were validated when saved and the recipients come from the
      // users table, but nothing that could redirect the key or inject a header is ever sent.
      if (!isPublicHostName(opts.host)) return { status: "failed", code: "bad_host" };
      if (
        !plainAddress(opts.from) ||
        msg.to.length > MAX_RECIPIENTS ||
        !msg.to.every(plainAddress) ||
        CONTROL.test(msg.subject) ||
        msg.subject.length > 300
      ) {
        return { status: "failed", code: "bad_message" };
      }
      const doFetch = opts.fetchFn ?? ((i, init) => fetch(i, init));
      let res: Response;
      try {
        res = await doFetch(`https://${opts.host}/emails`, {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: opts.from,
            to: [...msg.to],
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        return {
          status: "unknown",
          code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error",
        };
      }
      const s = res.status;
      if (s >= 200 && s < 300) {
        // Accepted. The answer is only read for the id, capped in size; anything odd (too long, not
        // JSON, not an object, an id with spaces or control characters) still means sent, id null.
        let id: string | null = null;
        try {
          const text = await readCapped(res, MAX_ANSWER_BYTES);
          const j: unknown = text === null ? null : JSON.parse(text);
          if (j !== null && typeof j === "object" && !Array.isArray(j)) {
            id = safeId(Object.getOwnPropertyDescriptor(j, "id")?.value);
          }
        } catch {
          id = null;
        }
        return { status: "sent", providerMessageId: id };
      }
      // Drain nothing: the answer text is never read or logged.
      void res.body?.cancel().catch(() => undefined);
      if (s === 429) {
        // Rate limited: a definite refusal. Retry-After (whole seconds) is passed on so the caller
        // can back off; a date form or garbage is ignored.
        const ra = Number(res.headers.get("retry-after"));
        return {
          status: "failed",
          code: "http_429",
          ...(Number.isInteger(ra) && ra > 0
            ? { retryAfterSeconds: Math.min(ra, MAX_RETRY_AFTER_S) }
            : {}),
        };
      }
      if (s >= 400 && s < 500 && s !== 408) return { status: "failed", code: `http_${s}` };
      return { status: "unknown", code: `http_${s}` };
    },
  };
}

/** The sender the settings and the secret describe; incomplete configuration means disabled. */
export function senderFromSettings(
  env: { EMAIL_API_KEY?: string },
  s: DqNotificationSettings,
  fetchFn?: typeof fetch,
): EmailSender {
  const key = typeof env.EMAIL_API_KEY === "string" ? env.EMAIL_API_KEY.trim() : "";
  if (s.emailProvider !== "https" || s.emailHost === "" || s.emailFrom === "" || key === "") {
    return disabledSender;
  }
  return httpsSender({
    host: s.emailHost,
    from: s.emailFrom,
    apiKey: key,
    ...(fetchFn ? { fetchFn } : {}),
  });
}
