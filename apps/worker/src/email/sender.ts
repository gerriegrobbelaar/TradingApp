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
import type { DqNotificationSettings, EmailMessage, EmailSendResult } from "@camelthorn/core";

export interface EmailSender {
  readonly kind: "disabled" | "https";
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

export const disabledSender: EmailSender = {
  kind: "disabled",
  send: () => Promise.resolve({ status: "skipped_not_configured" }),
};

export const SEND_TIMEOUT_MS = 10_000;

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
    async send(msg: EmailMessage): Promise<EmailSendResult> {
      if (msg.to.length === 0) return { status: "failed", code: "no_recipients" };
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
        let id: string | null = null;
        try {
          const j = (await res.json()) as { id?: unknown };
          if (typeof j.id === "string" && j.id.length > 0 && j.id.length <= 200) id = j.id;
        } catch {
          // accepted without a readable id: still sent
        }
        return { status: "sent", providerMessageId: id };
      }
      // Drain nothing: the answer text is never read or logged.
      void res.body?.cancel().catch(() => undefined);
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
