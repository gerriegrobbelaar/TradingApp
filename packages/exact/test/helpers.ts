import type { ExactRequest, ExactResponse, ExactTransport } from "../src/transport";

export type Reply = ExactResponse | Error;

export function ok(body: string, headers: Record<string, string> = {}): ExactResponse {
  return { status: 200, headers, body };
}

export function status(
  code: number,
  body = "",
  headers: Record<string, string> = {},
): ExactResponse {
  return { status: code, headers, body };
}

/** Scripted transport: replies are consumed in order; every request is recorded. */
export function scripted(replies: Reply[]): { transport: ExactTransport; calls: ExactRequest[] } {
  const calls: ExactRequest[] = [];
  let i = 0;
  const transport: ExactTransport = async (req) => {
    calls.push(req);
    const r = replies[i++];
    if (r === undefined) throw new Error("no scripted reply left");
    if (r instanceof Error) throw r;
    return r;
  };
  return { transport, calls };
}
