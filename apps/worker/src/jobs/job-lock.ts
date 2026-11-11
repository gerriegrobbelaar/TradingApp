/**
 * JobLock: one Durable Object per job name ("job:<name>", EU jurisdiction via getEuObject). It
 * grants a lease with a time to live, so two runs of the same job never execute at once (CLAUDE.md
 * 4.1). A Durable Object runs one event at a time, so `acquire` is atomic without any extra lock.
 *
 * The lease expires by itself: a run whose isolate died stops heartbeating and the next run takes
 * the lock once the TTL has passed (no alarm needed). The holder is a random token; `release` and
 * `heartbeat` by anybody else do nothing, so a zombie cannot free or extend someone else's lease.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export interface Lease {
  holder: string;
  /** Epoch ms at which the lease ends. */
  until: number;
}

export type AcquireResult = { ok: true; until: number } | { ok: false; heldUntil: number };

const KEY = "lease";
/** Longest TTL a caller may ask for; a bug cannot lock a job for ever. */
export const MAX_TTL_MS = 30 * 60 * 1000;

const clampTtl = (ttlMs: number): number =>
  Number.isFinite(ttlMs) ? Math.min(Math.max(Math.trunc(ttlMs), 1), MAX_TTL_MS) : MAX_TTL_MS;

export class JobLock extends DurableObject<Env> {
  async acquire(holder: string, ttlMs: number): Promise<AcquireResult> {
    const now = Date.now();
    const cur = await this.ctx.storage.get<Lease>(KEY);
    if (cur && cur.until > now && cur.holder !== holder) return { ok: false, heldUntil: cur.until };
    const until = now + clampTtl(ttlMs);
    await this.ctx.storage.put<Lease>(KEY, { holder, until });
    return { ok: true, until };
  }

  /** Extends the lease if `holder` still has it (also when it just expired and nobody took it). */
  async heartbeat(holder: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const cur = await this.ctx.storage.get<Lease>(KEY);
    if (!cur || cur.holder !== holder) return false;
    await this.ctx.storage.put<Lease>(KEY, { holder, until: now + clampTtl(ttlMs) });
    return true;
  }

  async release(holder: string): Promise<boolean> {
    const cur = await this.ctx.storage.get<Lease>(KEY);
    if (!cur || cur.holder !== holder) return false;
    await this.ctx.storage.delete(KEY);
    return true;
  }

  /** Who holds the lease right now (diagnostics and tests). */
  async peek(): Promise<Lease | null> {
    const cur = await this.ctx.storage.get<Lease>(KEY);
    return cur && cur.until > Date.now() ? cur : null;
  }
}
