import type { RevolutRequest, RevolutResponse, RevolutTransport } from "../src/transport";

export type Reply = RevolutResponse | Error;

export function ok(body: string, headers: Record<string, string> = {}): RevolutResponse {
  return { status: 200, headers, body };
}

export function status(code: number, body = "", headers: Record<string, string> = {}) {
  return { status: code, headers, body } satisfies RevolutResponse;
}

/** Scripted transport: replies are consumed in order; every request is recorded. */
export function scripted(replies: Reply[]): {
  transport: RevolutTransport;
  calls: RevolutRequest[];
} {
  const calls: RevolutRequest[] = [];
  let i = 0;
  const transport: RevolutTransport = async (req) => {
    calls.push(req);
    const r = replies[i++];
    if (r === undefined) throw new Error("no scripted reply left");
    if (r instanceof Error) throw r;
    return r;
  };
  return { transport, calls };
}

export interface FakeTx {
  id: string;
  createdAt: string;
  state?: string;
  updatedAt?: string;
}

/** Microseconds since epoch for an ISO string, for exact comparisons in the fake server. */
export function micros(input: string): bigint {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00Z` : input;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(iso);
  if (!m) throw new Error(`bad ts ${iso}`);
  const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(Date.parse(`${m[1]}.000Z`)) * 1000n + BigInt(frac);
}

export function txJson(t: FakeTx): Record<string, unknown> {
  return {
    id: t.id,
    type: "transfer",
    state: t.state ?? "completed",
    created_at: t.createdAt,
    updated_at: t.updatedAt ?? t.createdAt,
    legs: [{ leg_id: `${t.id}-l1`, amount: -1.5, currency: "EUR", account_id: "acc-1" }],
  };
}

export interface FakeServerOptions {
  /** `to` excludes rows at exactly that instant (default inclusive). */
  exclusiveTo?: boolean;
  /** Server-side cap on rows per call, below what the client asks for. */
  maxCount?: number;
  /** Drop this many rows from the end of a full page (a short page that is not the end). */
  randomShort?: () => number;
  /** Change rows between calls (state changes mid-walk). */
  mutate?: (call: number, data: FakeTx[]) => void;
}

/**
 * Fake GET /transactions: newest first, `from`/`to` inclusive on created_at at full precision,
 * `count` rows. Records the calls. Ties are returned in an arbitrary (shuffled by id) order.
 */
export function fakeTransactionsServer(
  data: FakeTx[],
  opts: FakeServerOptions = {},
): {
  transport: RevolutTransport;
  calls: RevolutRequest[];
} {
  const calls: RevolutRequest[] = [];
  const transport: RevolutTransport = async (req) => {
    calls.push(req);
    opts.mutate?.(calls.length, data);
    const q = req.query ?? {};
    let count = Number(q["count"] ?? "100");
    if (opts.maxCount !== undefined) count = Math.min(count, opts.maxCount);
    const from = q["from"] === undefined ? null : micros(q["from"]);
    const to = q["to"] === undefined ? null : micros(q["to"]);
    let rows = data
      .filter(
        (t) =>
          (from === null || micros(t.createdAt) >= from) &&
          (to === null ||
            (opts.exclusiveTo === true ? micros(t.createdAt) < to : micros(t.createdAt) <= to)),
      )
      .sort((a, b) => {
        const d = micros(b.createdAt) - micros(a.createdAt);
        if (d !== 0n) return d > 0n ? 1 : -1;
        return a.id < b.id ? 1 : -1; // adversarial: opposite of the client's tie-break
      })
      .slice(0, count);
    // Only full pages are shortened: the server hides that more rows exist.
    if (opts.randomShort !== undefined && rows.length === count) {
      rows = rows.slice(0, Math.max(0, rows.length - opts.randomShort()));
    }
    return { status: 200, headers: {}, body: JSON.stringify(rows.map(txJson)) };
  };
  return { transport, calls };
}
